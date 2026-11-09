/**
 * Backend for the legacy REST API (/apirest.php), available in GLPI 9.x, 10 and 11.
 *
 * Auth: initSession with an App-Token (optional, if the API client defines one)
 * plus either "Authorization: user_token <token>" or HTTP Basic login/password.
 * Every other call carries the Session-Token. An expired session is renewed once
 * automatically.
 */
import type { Config } from "../config.js";
import { GlpiApiError, httpRequest, toPhpQuery, totalFromContentRange, type FetchLike } from "./http.js";
import {
  label,
  PRIORITY_LABELS,
  STATUS_LABELS,
  TICKET_TYPE_LABELS,
  type GlpiBackend,
  type ItemRef,
  type ItilCreateInput,
  type ItilQuery,
  type ItilSummary,
  type ItilType,
  type ItilUpdateInput,
  type Page,
  type TaskInput,
  type TeamMemberType,
  type TeamRole,
} from "./types.js";

/** Search option IDs shared by Ticket, Change and Problem. */
export const ITIL_FIELDS = {
  name: 1,
  id: 2,
  priority: 3,
  requester: 4,
  assignedUser: 5,
  category: 7,
  assignedGroup: 8,
  status: 12,
  type: 14, // Ticket only
  date: 15,
  dateMod: 19,
} as const;

const ROLE_TO_TYPE: Record<TeamRole, number> = { requester: 1, assigned: 2, observer: 3 };

const ITIL_LINKS: Record<ItilType, { fk: string; task: string; user: string; group: string }> = {
  Ticket: { fk: "tickets_id", task: "TicketTask", user: "Ticket_User", group: "Group_Ticket" },
  Change: { fk: "changes_id", task: "ChangeTask", user: "Change_User", group: "Change_Group" },
  Problem: { fk: "problems_id", task: "ProblemTask", user: "Problem_User", group: "Group_Problem" },
};

const ITEMTYPE_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

export function assertItemtype(itemtype: string): string {
  if (!ITEMTYPE_RE.test(itemtype)) throw new Error(`Invalid itemtype: ${itemtype}`);
  return itemtype;
}

export class LegacyBackend implements GlpiBackend {
  readonly kind = "legacy" as const;
  private readonly base: string;
  private sessionToken?: string;
  private sessionPromise?: Promise<string>;

  constructor(
    private readonly config: Config,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.base = `${config.glpiUrl}/apirest.php`;
  }

  // ---------------------------------------------------------------- session

  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    const { appToken, userToken, username, password } = this.config.legacy;
    if (appToken) h["App-Token"] = appToken;
    if (userToken) h.Authorization = `user_token ${userToken}`;
    else if (username && password) {
      h.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
    }
    return h;
  }

  private async initSession(): Promise<string> {
    const res = await httpRequest<{ session_token?: string }>(this.fetchImpl, `${this.base}/initSession`, {
      method: "GET",
      headers: this.authHeaders(),
      timeoutMs: this.config.timeoutMs,
    });
    if (res.status !== 200 || !res.body?.session_token) {
      throw new GlpiApiError(res.status, "GET", "initSession", res.body);
    }
    return res.body.session_token;
  }

  private async session(): Promise<string> {
    if (this.sessionToken) return this.sessionToken;
    this.sessionPromise ??= this.initSession().finally(() => {
      this.sessionPromise = undefined;
    });
    this.sessionToken = await this.sessionPromise;
    return this.sessionToken;
  }

  private headers(token: string): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json", "Session-Token": token };
    if (this.config.legacy.appToken) h["App-Token"] = this.config.legacy.appToken;
    return h;
  }

  async request<T = unknown>(
    method: string,
    path: string,
    opts: { query?: Record<string, unknown>; body?: unknown } = {},
  ): Promise<{ body: T; headers: Headers; status: number }> {
    const qs = opts.query ? toPhpQuery(opts.query) : "";
    const url = `${this.base}/${path.replace(/^\/+/, "")}${qs ? `?${qs}` : ""}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.session();
      const res = await httpRequest<T>(this.fetchImpl, url, {
        method,
        headers: this.headers(token),
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        timeoutMs: this.config.timeoutMs,
      });
      if (res.status === 401 && attempt === 0 && isSessionError(res.body)) {
        this.sessionToken = undefined;
        continue;
      }
      // 206 Partial Content is normal for ranged lists.
      if (res.status >= 400) throw new GlpiApiError(res.status, method, path, res.body);
      return res;
    }
    throw new Error("unreachable");
  }

  async close(): Promise<void> {
    if (!this.sessionToken) return;
    try {
      await httpRequest(this.fetchImpl, `${this.base}/killSession`, {
        method: "GET",
        headers: this.headers(this.sessionToken),
        timeoutMs: 5000,
      });
    } catch {
      /* best effort */
    }
    this.sessionToken = undefined;
  }

  // ------------------------------------------------------------- discovery

  async describe(): Promise<Record<string, unknown>> {
    const info: Record<string, unknown> = { api: "legacy", endpoint: this.base };
    try {
      const { body } = await this.request<{ cfg_glpi?: { version?: string } }>("GET", "getGlpiConfig");
      if (body?.cfg_glpi?.version) info.glpi_version = body.cfg_glpi.version;
    } catch {
      info.glpi_version = "unknown (getGlpiConfig not allowed for this profile)";
    }
    return info;
  }

  async whoami(): Promise<unknown> {
    const { body } = await this.request<{ session?: Record<string, unknown> }>("GET", "getFullSession");
    const s = body?.session ?? {};
    const profile = s.glpiactiveprofile as Record<string, unknown> | undefined;
    return {
      user_id: s.glpiID,
      login: s.glpiname,
      firstname: s.glpifirstname,
      realname: s.glpirealname,
      active_profile: profile?.name,
      active_entity: s.glpiactive_entity_name ?? s.glpiactive_entity,
      recursive_entities: s.glpiactive_entity_recursive,
    };
  }

  // ------------------------------------------------------------------ ITIL

  async listItil(q: ItilQuery): Promise<Page<ItilSummary>> {
    const criteria: Record<string, unknown>[] = [];
    const statuses = q.statuses?.length ? q.statuses.map(String) : q.openOnly ? ["notold"] : [];
    if (statuses.length) {
      criteria.push({
        link: "AND",
        criteria: statuses.map((s, i) => ({
          link: i === 0 ? "AND" : "OR",
          field: ITIL_FIELDS.status,
          searchtype: "equals",
          value: s,
        })),
      });
    }
    if (q.priorities?.length) {
      criteria.push({
        link: "AND",
        criteria: q.priorities.map((p, i) => ({
          link: i === 0 ? "AND" : "OR",
          field: ITIL_FIELDS.priority,
          searchtype: "equals",
          value: p,
        })),
      });
    }
    const eq = (field: number, value: unknown) =>
      value !== undefined && criteria.push({ link: "AND", field, searchtype: "equals", value });
    if (q.text) criteria.push({ link: "AND", field: ITIL_FIELDS.name, searchtype: "contains", value: q.text });
    if (q.itilType === "Ticket") eq(ITIL_FIELDS.type, q.ticketType);
    else if (q.ticketType !== undefined) throw new Error("ticket_type applies to tickets only");
    eq(ITIL_FIELDS.category, q.categoryId);
    eq(ITIL_FIELDS.assignedUser, q.assignedUserId);
    eq(ITIL_FIELDS.assignedGroup, q.assignedGroupId);
    eq(ITIL_FIELDS.requester, q.requesterUserId);

    const display = [
      ITIL_FIELDS.name,
      ITIL_FIELDS.id,
      ITIL_FIELDS.status,
      ITIL_FIELDS.priority,
      ITIL_FIELDS.category,
      ITIL_FIELDS.date,
      ITIL_FIELDS.dateMod,
      ITIL_FIELDS.requester,
      ITIL_FIELDS.assignedUser,
      ITIL_FIELDS.assignedGroup,
      ...(q.itilType === "Ticket" ? [ITIL_FIELDS.type] : []),
    ];
    const { body } = await this.request<{ totalcount?: number; data?: Record<string, unknown>[] }>(
      "GET",
      `search/${q.itilType}`,
      {
        query: {
          criteria,
          forcedisplay: display,
          sort: ITIL_FIELDS.dateMod,
          order: "DESC",
          range: `${q.start}-${q.start + q.limit - 1}`,
        },
      },
    );
    const rows = body?.data ?? [];
    const f = (row: Record<string, unknown>, id: number) => cleanCell(row[String(id)]);
    return {
      start: q.start,
      limit: q.limit,
      total: body?.totalcount,
      items: rows.map((row) => ({
        id: Number(row[String(ITIL_FIELDS.id)]),
        name: String(f(row, ITIL_FIELDS.name) ?? ""),
        status: label(STATUS_LABELS, row[String(ITIL_FIELDS.status)]),
        priority: label(PRIORITY_LABELS, row[String(ITIL_FIELDS.priority)]),
        type: q.itilType === "Ticket" ? label(TICKET_TYPE_LABELS, row[String(ITIL_FIELDS.type)]) : undefined,
        category: f(row, ITIL_FIELDS.category),
        date_creation: f(row, ITIL_FIELDS.date),
        date_mod: f(row, ITIL_FIELDS.dateMod),
        requester: f(row, ITIL_FIELDS.requester),
        assigned_user: f(row, ITIL_FIELDS.assignedUser),
        assigned_group: f(row, ITIL_FIELDS.assignedGroup),
      })),
    };
  }

  async getItil(itilType: ItilType, id: number): Promise<unknown> {
    const { body } = await this.request<Record<string, unknown>>("GET", `${itilType}/${id}`, {
      query: { expand_dropdowns: true },
    });
    return {
      ...body,
      status_label: label(STATUS_LABELS, body?.status),
      priority_label: label(PRIORITY_LABELS, body?.priority),
      ...(itilType === "Ticket" ? { type_label: label(TICKET_TYPE_LABELS, body?.type) } : {}),
    };
  }

  async getItilTimeline(itilType: ItilType, id: number): Promise<unknown> {
    const links = ITIL_LINKS[itilType];
    const sub = async (name: string) => {
      try {
        const { body } = await this.request<unknown[]>("GET", `${itilType}/${id}/${name}`, {
          query: { expand_dropdowns: true },
        });
        return Array.isArray(body) ? body : [];
      } catch (err) {
        if (err instanceof GlpiApiError && (err.status === 404 || err.status === 400)) return [];
        throw err;
      }
    };
    const [followups, tasks, solutions] = await Promise.all([
      sub("ITILFollowup"),
      sub(links.task),
      sub("ITILSolution"),
    ]);
    const entries = [
      ...followups.map((x) => ({ kind: "followup", ...(x as object) })),
      ...tasks.map((x) => ({ kind: "task", ...(x as object) })),
      ...solutions.map((x) => ({ kind: "solution", ...(x as object) })),
    ] as Array<Record<string, unknown>>;
    entries.sort((a, b) => String(a.date_creation ?? a.date ?? "").localeCompare(String(b.date_creation ?? b.date ?? "")));
    return { itil_type: itilType, id, entries };
  }

  async getItilTeam(itilType: ItilType, id: number): Promise<unknown> {
    const links = ITIL_LINKS[itilType];
    const roleName = (t: unknown) =>
      (Object.entries(ROLE_TO_TYPE).find(([, v]) => v === Number(t))?.[0] as TeamRole | undefined) ?? String(t);
    const get = async (name: string) => {
      const { body } = await this.request<Record<string, unknown>[]>("GET", `${itilType}/${id}/${name}`, {
        query: { expand_dropdowns: true },
      });
      return Array.isArray(body) ? body : [];
    };
    const [users, groups] = await Promise.all([get(links.user), get(links.group)]);
    return {
      users: users.map((u) => ({ link_id: u.id, user: u.users_id, role: roleName(u.type), email: u.alternative_email || undefined })),
      groups: groups.map((g) => ({ link_id: g.id, group: g.groups_id, role: roleName(g.type) })),
    };
  }

  async createItil(input: ItilCreateInput): Promise<unknown> {
    const payload: Record<string, unknown> = { name: input.name, content: input.content };
    if (input.itilType === "Ticket" && input.ticketType !== undefined) payload.type = input.ticketType;
    setIf(payload, "urgency", input.urgency);
    setIf(payload, "impact", input.impact);
    setIf(payload, "priority", input.priority);
    setIf(payload, "itilcategories_id", input.categoryId);
    setIf(payload, "entities_id", input.entityId);
    setIf(payload, "locations_id", input.locationId);
    setIf(payload, "_users_id_requester", input.requesterUserId);
    setIf(payload, "_users_id_assign", input.assignedUserId);
    setIf(payload, "_groups_id_assign", input.assignedGroupId);
    const { body } = await this.request("POST", input.itilType, { body: { input: payload } });
    return body;
  }

  async updateItil(itilType: ItilType, id: number, f: ItilUpdateInput): Promise<unknown> {
    const payload: Record<string, unknown> = { ...(f.extra ?? {}) };
    setIf(payload, "name", f.name);
    setIf(payload, "content", f.content);
    setIf(payload, "status", f.status);
    setIf(payload, "urgency", f.urgency);
    setIf(payload, "impact", f.impact);
    setIf(payload, "priority", f.priority);
    setIf(payload, "itilcategories_id", f.categoryId);
    setIf(payload, "locations_id", f.locationId);
    if (itilType === "Ticket") setIf(payload, "type", f.ticketType);
    if (!Object.keys(payload).length) throw new Error("Nothing to update: give at least one field");
    const { body } = await this.request("PUT", `${itilType}/${id}`, { body: { input: payload } });
    return body;
  }

  async addFollowup(itilType: ItilType, id: number, content: string, isPrivate: boolean): Promise<unknown> {
    const { body } = await this.request("POST", "ITILFollowup", {
      body: { input: { itemtype: itilType, items_id: id, content, is_private: isPrivate ? 1 : 0 } },
    });
    return body;
  }

  async addTask(itilType: ItilType, id: number, t: TaskInput): Promise<unknown> {
    const links = ITIL_LINKS[itilType];
    const payload: Record<string, unknown> = { [links.fk]: id, content: t.content, is_private: t.isPrivate ? 1 : 0 };
    setIf(payload, "state", t.state);
    setIf(payload, "actiontime", t.durationSeconds);
    setIf(payload, "users_id_tech", t.techUserId);
    const { body } = await this.request("POST", links.task, { body: { input: payload } });
    return body;
  }

  async addSolution(itilType: ItilType, id: number, content: string): Promise<unknown> {
    const { body } = await this.request("POST", "ITILSolution", {
      body: { input: { itemtype: itilType, items_id: id, content } },
    });
    return body;
  }

  async addTeamMember(
    itilType: ItilType,
    id: number,
    memberType: TeamMemberType,
    memberId: number,
    role: TeamRole,
  ): Promise<unknown> {
    const links = ITIL_LINKS[itilType];
    const itemtype = memberType === "User" ? links.user : links.group;
    const key = memberType === "User" ? "users_id" : "groups_id";
    const { body } = await this.request("POST", itemtype, {
      body: { input: { [links.fk]: id, [key]: memberId, type: ROLE_TO_TYPE[role] } },
    });
    return body;
  }

  // --------------------------------------------------------------- generic

  async searchItems(itemtype: string, text: string, start: number, limit: number): Promise<Page<ItemRef>> {
    assertItemtype(itemtype);
    const { body } = await this.request<{ totalcount?: number; data?: Record<string, unknown>[] }>(
      "GET",
      `search/${itemtype}`,
      {
        query: {
          criteria: [{ field: 1, searchtype: "contains", value: text }],
          forcedisplay: [1, 2, 80],
          range: `${start}-${start + limit - 1}`,
        },
      },
    );
    return {
      start,
      limit,
      total: body?.totalcount,
      items: (body?.data ?? []).map((row) => ({
        id: Number(row["2"]),
        name: cleanCell(row["1"]),
        entity: cleanCell(row["80"]),
      })),
    };
  }

  async listItems(itemtype: string, start: number, limit: number): Promise<Page<unknown>> {
    assertItemtype(itemtype);
    const res = await this.request<unknown[]>("GET", itemtype, {
      query: { range: `${start}-${start + limit - 1}`, expand_dropdowns: true },
    });
    return { start, limit, total: totalFromContentRange(res.headers), items: Array.isArray(res.body) ? res.body : [] };
  }

  async getItem(itemtype: string, id: number): Promise<unknown> {
    assertItemtype(itemtype);
    const { body } = await this.request("GET", `${itemtype}/${id}`, { query: { expand_dropdowns: true } });
    return body;
  }

  async createItem(itemtype: string, fields: Record<string, unknown>): Promise<unknown> {
    assertItemtype(itemtype);
    const { body } = await this.request("POST", itemtype, { body: { input: fields } });
    return body;
  }

  async updateItem(itemtype: string, id: number, fields: Record<string, unknown>): Promise<unknown> {
    assertItemtype(itemtype);
    const { body } = await this.request("PUT", `${itemtype}/${id}`, { body: { input: fields } });
    return body;
  }

  async deleteItem(itemtype: string, id: number, purge: boolean): Promise<unknown> {
    assertItemtype(itemtype);
    const { body } = await this.request("DELETE", `${itemtype}/${id}`, { query: { force_purge: purge } });
    return body;
  }

  async rawGet(path: string, query?: Record<string, unknown>): Promise<unknown> {
    const clean = path.replace(/^\/*(apirest\.php\/)?/, "");
    if (clean.includes("..")) throw new Error("Invalid path");
    const res = await this.request("GET", clean, { query });
    return { status: res.status, total: totalFromContentRange(res.headers), body: res.body };
  }
}

function setIf(target: Record<string, unknown>, key: string, value: unknown) {
  if (value !== undefined && value !== null) target[key] = value;
}

/**
 * Remove HTML tags so a search cell reads as plain text.
 * A single pass can rebuild a tag from its pieces ("<scr<b>ipt>" -> "<script>"),
 * so strip until nothing changes and then drop any stray angle brackets.
 */
export function stripTags(input: string): string {
  let text = input;
  let previous: string;
  do {
    previous = text;
    text = text.replace(/<[^<>]*>/g, "");
  } while (text !== previous);
  return text.replace(/[<>]/g, "");
}

/** Search results may hold HTML (links) or arrays for multi-valued fields. */
export function cleanCell(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (Array.isArray(value)) return value.map((v) => cleanCell(v)).filter(Boolean).join(", ") || undefined;
  return stripTags(String(value))
    .replace(/&nbsp;/g, " ")
    .replace(/\$\$\$\$/g, ", ")
    .trim() || undefined;
}

function isSessionError(body: unknown): boolean {
  return Array.isArray(body) && typeof body[0] === "string" && /SESSION_TOKEN/i.test(body[0]);
}
