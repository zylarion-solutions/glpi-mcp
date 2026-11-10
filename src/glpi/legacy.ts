/**
 * Backend for the legacy REST API (/apirest.php), available in GLPI 9.5, 10 and 11.
 *
 * Auth: initSession with an App-Token (optional, if the API client defines one)
 * plus either "Authorization: user_token <token>" or HTTP Basic login/password.
 * Every other call carries the Session-Token. An expired session is renewed once
 * automatically.
 *
 * Search option IDs used here were checked against GLPI 10.0 sources
 * (CommonITILObject::rawSearchOptions, Ticket, KnowbaseItem, User).
 */
import type { Config } from "../config.js";
import { decodeEntities, excerpt, htmlToText, stripTags, textifyRecord } from "../text.js";
import { GlpiApiError, httpRequest, toPhpQuery, totalFromContentRange, type FetchLike } from "./http.js";
import { keywords, scoreText } from "./similar.js";
import { computeItilStats, type StatsRow } from "./stats.js";
import {
  label,
  PRIORITY_LABELS,
  STATUS_LABELS,
  TICKET_TYPE_LABELS,
  type DocumentInfo,
  type DownloadedDocument,
  type GlpiBackend,
  type ItemRef,
  type ItilCreateInput,
  type ItilQuery,
  type ItilSummary,
  type ItilType,
  type ItilUpdateInput,
  type Page,
  type QueueQuery,
  type SessionInfo,
  type SimilarHit,
  type SimilarQuery,
  type SlaItem,
  type SlaQuery,
  type StatsQuery,
  type TaskInput,
  type TeamMemberType,
  type TeamRole,
  type ValidationDecision,
  type ValidationItem,
} from "./types.js";

export { stripTags };

/** Search option IDs shared by Ticket, Change and Problem (plus Ticket-only ones). */
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
  solveDate: 17,
  timeToResolve: 18,
  dateMod: 19,
  content: 21,
  takeIntoAccountDelay: 150, // Ticket only, seconds
  solveDelay: 154, // seconds
  timeToOwn: 155, // Ticket only
  internalTimeToResolve: 180, // Ticket only
  internalTimeToOwn: 185, // Ticket only
} as const;

/** Name-like search options per itemtype (default: 1). */
const NAME_FIELDS: Record<string, number[]> = {
  User: [1, 9, 34], // login, firstname, realname
  KnowbaseItem: [6],
};

const KB_FIELDS = { name: 6, id: 2, answer: 7 } as const;

const ROLE_TO_TYPE: Record<TeamRole, number> = { requester: 1, assigned: 2, observer: 3 };

const ITIL_LINKS: Record<ItilType, { fk: string; task: string; user: string; group: string; validation?: string }> = {
  Ticket: { fk: "tickets_id", task: "TicketTask", user: "Ticket_User", group: "Group_Ticket", validation: "TicketValidation" },
  Change: { fk: "changes_id", task: "ChangeTask", user: "Change_User", group: "Change_Group", validation: "ChangeValidation" },
  Problem: { fk: "problems_id", task: "ProblemTask", user: "Problem_User", group: "Group_Problem" },
};

const VALIDATION_STATUS: Record<number, string> = { 1: "none", 2: "waiting", 3: "accepted", 4: "refused" };

const ITEMTYPE_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

export function assertItemtype(itemtype: string): string {
  if (!ITEMTYPE_RE.test(itemtype)) throw new Error(`Invalid itemtype: ${itemtype}`);
  return itemtype;
}

export interface Criterion {
  link?: "AND" | "OR" | "AND NOT" | "OR NOT";
  field?: number;
  searchtype?: string;
  value?: string | number;
  criteria?: Criterion[];
}

export interface LegacyOverrides {
  /** Use this user token instead of the configured credentials (per-user mode). */
  userToken?: string;
}

export class LegacyBackend implements GlpiBackend {
  readonly kind = "legacy" as const;
  private readonly base: string;
  private sessionToken?: string;
  private sessionPromise?: Promise<string>;
  private sessionCache?: SessionInfo;

  constructor(
    private readonly config: Config,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly overrides: LegacyOverrides = {},
  ) {
    this.base = `${config.glpiUrl}/apirest.php`;
  }

  // ---------------------------------------------------------------- session

  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    const { appToken, username, password } = this.config.legacy;
    const userToken = this.overrides.userToken ?? this.config.legacy.userToken;
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

  private async sessionTokenValue(): Promise<string> {
    if (this.sessionToken) return this.sessionToken;
    this.sessionPromise ??= this.initSession().finally(() => {
      this.sessionPromise = undefined;
    });
    this.sessionToken = await this.sessionPromise;
    return this.sessionToken;
  }

  private headers(token: string, extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      "Session-Token": token,
      // Raw HTML instead of entity-encoded text (GLPI >= 9.5); decoded anyway for older versions.
      "X-GLPI-Sanitized-Content": "false",
      ...extra,
    };
    if (this.config.legacy.appToken) h["App-Token"] = this.config.legacy.appToken;
    return h;
  }

  async request<T = unknown>(
    method: string,
    path: string,
    opts: {
      query?: Record<string, unknown>;
      body?: unknown;
      form?: FormData;
      binary?: boolean;
      maxBytes?: number;
    } = {},
  ): Promise<{ body: T; headers: Headers; status: number }> {
    const qs = opts.query ? toPhpQuery(opts.query) : "";
    const url = `${this.base}/${path.replace(/^\/+/, "")}${qs ? `?${qs}` : ""}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.sessionTokenValue();
      const headers = this.headers(token, opts.binary ? { Accept: "application/octet-stream" } : {});
      if (opts.form) delete headers["Content-Type"]; // fetch sets the multipart boundary
      const res = await httpRequest<T>(this.fetchImpl, url, {
        method,
        headers,
        body: opts.form ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
        timeoutMs: this.config.timeoutMs,
        binary: opts.binary,
        maxBytes: opts.maxBytes,
      });
      if (res.status === 401 && attempt === 0 && isSessionError(res.body)) {
        this.sessionToken = undefined;
        this.sessionCache = undefined;
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
    this.sessionCache = undefined;
  }

  /** Run the GLPI search engine. Out-of-range pages come back empty instead of failing. */
  async search(
    itemtype: string,
    opts: {
      criteria?: Criterion[];
      display: number[];
      sort?: number;
      order?: "ASC" | "DESC";
      start: number;
      limit: number;
    },
  ): Promise<{ total: number; rows: Record<string, unknown>[] }> {
    assertItemtype(itemtype);
    try {
      const { body } = await this.request<{ totalcount?: number; data?: Record<string, unknown>[] }>(
        "GET",
        `search/${itemtype}`,
        {
          query: {
            criteria: opts.criteria?.length ? opts.criteria : undefined,
            forcedisplay: opts.display,
            sort: opts.sort,
            order: opts.order,
            range: `${opts.start}-${opts.start + opts.limit - 1}`,
          },
        },
      );
      return { total: Number(body?.totalcount ?? 0), rows: Array.isArray(body?.data) ? body.data : [] };
    } catch (err) {
      if (err instanceof GlpiApiError && Array.isArray(err.body) && err.body[0] === "ERROR_RANGE_EXCEED_TOTAL") {
        return { total: 0, rows: [] };
      }
      throw err;
    }
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
    const s = await this.session();
    return {
      user_id: s.userId,
      login: s.login,
      name: s.name,
      active_profile: s.profile,
      active_entity: s.entity,
      group_ids: s.groupIds,
    };
  }

  async session(): Promise<SessionInfo> {
    if (this.sessionCache) return this.sessionCache;
    const { body } = await this.request<{ session?: Record<string, unknown> }>("GET", "getFullSession");
    const s = body?.session ?? {};
    const profile = s.glpiactiveprofile as Record<string, unknown> | undefined;
    const groups = Array.isArray(s.glpigroups) ? s.glpigroups : Object.values((s.glpigroups as object) ?? {});
    const name = [s.glpifirstname, s.glpirealname].filter(Boolean).join(" ").trim();
    this.sessionCache = {
      userId: Number(s.glpiID),
      login: s.glpiname as string | undefined,
      name: name || undefined,
      groupIds: groups.map(Number).filter((n) => Number.isFinite(n) && n > 0),
      profile: profile?.name as string | undefined,
      entity: (s.glpiactive_entity_name ?? s.glpiactive_entity) as string | undefined,
    };
    return this.sessionCache;
  }

  // ------------------------------------------------------------------ ITIL

  private summaryDisplay(itilType: ItilType): number[] {
    return [
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
      ...(itilType === "Ticket" ? [ITIL_FIELDS.type] : []),
    ];
  }

  private toSummary(row: Record<string, unknown>, itilType: ItilType): ItilSummary {
    const f = (id: number) => cleanCell(row[String(id)]);
    return {
      id: Number(row[String(ITIL_FIELDS.id)]),
      name: String(f(ITIL_FIELDS.name) ?? ""),
      status: label(STATUS_LABELS, row[String(ITIL_FIELDS.status)]),
      priority: label(PRIORITY_LABELS, row[String(ITIL_FIELDS.priority)]),
      type: itilType === "Ticket" ? label(TICKET_TYPE_LABELS, row[String(ITIL_FIELDS.type)]) : undefined,
      category: f(ITIL_FIELDS.category),
      date_creation: f(ITIL_FIELDS.date),
      date_mod: f(ITIL_FIELDS.dateMod),
      requester: f(ITIL_FIELDS.requester),
      assigned_user: f(ITIL_FIELDS.assignedUser),
      assigned_group: f(ITIL_FIELDS.assignedGroup),
    };
  }

  async listItil(q: ItilQuery): Promise<Page<ItilSummary>> {
    const criteria: Criterion[] = [];
    const statuses = q.statuses?.length ? q.statuses.map(String) : q.openOnly ? ["notold"] : [];
    if (statuses.length) criteria.push(anyOf(ITIL_FIELDS.status, statuses));
    if (q.priorities?.length) criteria.push(anyOf(ITIL_FIELDS.priority, q.priorities));
    const eq = (field: number, value: unknown) =>
      value !== undefined && criteria.push({ link: "AND", field, searchtype: "equals", value: value as number });
    if (q.text) {
      criteria.push({
        link: "AND",
        criteria: [
          { link: "AND", field: ITIL_FIELDS.name, searchtype: "contains", value: q.text },
          { link: "OR", field: ITIL_FIELDS.content, searchtype: "contains", value: q.text },
        ],
      });
    }
    if (q.itilType === "Ticket") eq(ITIL_FIELDS.type, q.ticketType);
    else if (q.ticketType !== undefined) throw new Error("ticket_type applies to tickets only");
    eq(ITIL_FIELDS.category, q.categoryId);
    eq(ITIL_FIELDS.assignedUser, q.assignedUserId);
    eq(ITIL_FIELDS.assignedGroup, q.assignedGroupId);
    eq(ITIL_FIELDS.requester, q.requesterUserId);

    const { total, rows } = await this.search(q.itilType, {
      criteria,
      display: this.summaryDisplay(q.itilType),
      sort: ITIL_FIELDS.dateMod,
      order: "DESC",
      start: q.start,
      limit: q.limit,
    });
    return { start: q.start, limit: q.limit, total, items: rows.map((r) => this.toSummary(r, q.itilType)) };
  }

  async getItil(itilType: ItilType, id: number): Promise<unknown> {
    const { body } = await this.request<Record<string, unknown>>("GET", `${itilType}/${id}`, {
      query: { expand_dropdowns: true },
    });
    let linked: unknown;
    if (itilType === "Ticket") {
      try {
        const res = await this.request<Record<string, unknown>[]>("GET", `Ticket/${id}/Item_Ticket`, {
          query: { expand_dropdowns: true },
        });
        linked = Array.isArray(res.body)
          ? res.body.map((l) => ({ itemtype: l.itemtype, item: l.items_id }))
          : undefined;
      } catch {
        linked = undefined;
      }
    }
    return {
      ...textifyRecord(body),
      status_label: label(STATUS_LABELS, body?.status),
      priority_label: label(PRIORITY_LABELS, body?.priority),
      ...(itilType === "Ticket" ? { type_label: label(TICKET_TYPE_LABELS, body?.type) } : {}),
      ...(linked && (linked as unknown[]).length ? { linked_items: linked } : {}),
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
    const pick = (x: unknown, kind: string) => {
      const r = x as Record<string, unknown>;
      return {
        kind,
        id: r.id,
        date: r.date_creation ?? r.date,
        author: r.users_id,
        is_private: r.is_private === undefined ? undefined : Boolean(Number(r.is_private)),
        content: htmlToText(r.content),
        ...(kind === "task"
          ? { state: r.state, duration_seconds: r.actiontime, technician: r.users_id_tech, group: r.groups_id_tech }
          : {}),
        ...(kind === "solution" ? { status: r.status } : {}),
      };
    };
    const entries = [
      ...followups.map((x) => pick(x, "followup")),
      ...tasks.map((x) => pick(x, "task")),
      ...solutions.map((x) => pick(x, "solution")),
    ];
    entries.sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? "")));
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
    const nameFields = NAME_FIELDS[itemtype] ?? [1];
    const criteria: Criterion[] = nameFields.map((field, i) => ({
      link: i === 0 ? "AND" : "OR",
      field,
      searchtype: "contains",
      value: text,
    }));
    const display = itemtype === "User" ? [1, 2, 9, 34, 5] : [...nameFields, 2, 80];
    const { total, rows } = await this.search(itemtype, { criteria, display, start, limit });
    return {
      start,
      limit,
      total,
      items: rows.map((row) => {
        const ref: ItemRef = { id: Number(row["2"]), name: cleanCell(row[String(nameFields[0])]) };
        if (itemtype === "User") {
          const full = [cleanCell(row["9"]), cleanCell(row["34"])].filter(Boolean).join(" ");
          if (full) ref.fullname = full;
          if (cleanCell(row["5"])) ref.email = cleanCell(row["5"]);
        } else if (cleanCell(row["80"])) {
          ref.entity = cleanCell(row["80"]);
        }
        return ref;
      }),
    };
  }

  async listItems(itemtype: string, start: number, limit: number): Promise<Page<unknown>> {
    assertItemtype(itemtype);
    const res = await this.request<unknown[]>("GET", itemtype, {
      query: { range: `${start}-${start + limit - 1}`, expand_dropdowns: true },
    });
    return {
      start,
      limit,
      total: totalFromContentRange(res.headers),
      items: Array.isArray(res.body) ? res.body.map((r) => textifyRecord(r)) : [],
    };
  }

  async getItem(itemtype: string, id: number): Promise<unknown> {
    assertItemtype(itemtype);
    const { body } = await this.request("GET", `${itemtype}/${id}`, { query: { expand_dropdowns: true } });
    return textifyRecord(body);
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

  // ------------------------------------------------------- my queue / SLA

  async myQueue(q: QueueQuery): Promise<Page<ItilSummary>> {
    const me = await this.session();
    const mine: Criterion[] = [{ link: "AND", field: ITIL_FIELDS.assignedUser, searchtype: "equals", value: me.userId }];
    if (q.includeGroups) {
      for (const g of me.groupIds) mine.push({ link: "OR", field: ITIL_FIELDS.assignedGroup, searchtype: "equals", value: g });
    }
    const statuses = q.statuses?.length ? q.statuses.map(String) : ["notold"];
    const { total, rows } = await this.search(q.itilType, {
      criteria: [anyOf(ITIL_FIELDS.status, statuses), { link: "AND", criteria: mine }],
      display: this.summaryDisplay(q.itilType),
      sort: ITIL_FIELDS.priority,
      order: "DESC",
      start: q.start,
      limit: q.limit,
    });
    return { start: q.start, limit: q.limit, total, items: rows.map((r) => this.toSummary(r, q.itilType)) };
  }

  async slaAtRisk(q: SlaQuery): Promise<{ overdue: SlaItem[]; due_soon: SlaItem[]; window_hours: number }> {
    const targets: Array<{ field: number; target: SlaItem["target"]; ownOnly: boolean }> = [];
    if (q.kinds.includes("resolve")) {
      targets.push({ field: ITIL_FIELDS.timeToResolve, target: "time_to_resolve", ownOnly: false });
      if (q.includeOla) targets.push({ field: ITIL_FIELDS.internalTimeToResolve, target: "internal_time_to_resolve", ownOnly: false });
    }
    if (q.kinds.includes("own")) {
      targets.push({ field: ITIL_FIELDS.timeToOwn, target: "time_to_own", ownOnly: true });
      if (q.includeOla) targets.push({ field: ITIL_FIELDS.internalTimeToOwn, target: "internal_time_to_own", ownOnly: true });
    }
    const scope: Criterion[] = [];
    if (q.assignedGroupId !== undefined) {
      scope.push({ link: "AND", field: ITIL_FIELDS.assignedGroup, searchtype: "equals", value: q.assignedGroupId });
    }
    if (q.assignedUserId !== undefined) {
      scope.push({ link: "AND", field: ITIL_FIELDS.assignedUser, searchtype: "equals", value: q.assignedUserId });
    }

    const overdue: SlaItem[] = [];
    const dueSoon: SlaItem[] = [];
    for (const t of targets) {
      // Time to own only matters while the ticket is still new (not taken into account).
      const status = t.ownOnly ? anyOf(ITIL_FIELDS.status, ["1"]) : anyOf(ITIL_FIELDS.status, ["notold"]);
      const display = [...this.summaryDisplay("Ticket"), t.field];
      const windows: Array<[Criterion[], SlaItem["state"]]> = [
        [[{ link: "AND", field: t.field, searchtype: "lessthan", value: "NOW" }], "overdue"],
        [
          [
            { link: "AND", field: t.field, searchtype: "morethan", value: "NOW" },
            { link: "AND", field: t.field, searchtype: "lessthan", value: `${q.withinHours}HOUR` },
          ],
          "due_soon",
        ],
      ];
      for (const [dateCriteria, state] of windows) {
        const { rows } = await this.search("Ticket", {
          criteria: [status, ...scope, ...dateCriteria],
          display,
          sort: t.field,
          order: "ASC",
          start: 0,
          limit: q.limit,
        });
        for (const r of rows) {
          const due = cleanCell(r[String(t.field)]);
          if (!due) continue;
          (state === "overdue" ? overdue : dueSoon).push({ ...this.toSummary(r, "Ticket"), target: t.target, due, state });
        }
      }
    }
    const byDue = (a: SlaItem, b: SlaItem) => a.due.localeCompare(b.due);
    return {
      overdue: dedupeSla(overdue).sort(byDue).slice(0, q.limit),
      due_soon: dedupeSla(dueSoon).sort(byDue).slice(0, q.limit),
      window_hours: q.withinHours,
    };
  }

  // ------------------------------------------------------ similar / KB first

  async findSimilar(q: SimilarQuery): Promise<SimilarHit[]> {
    const terms = keywords(q.text);
    if (!terms.length) throw new Error("The text has no searchable words; describe the problem in more detail");
    const termCriteria = (nameField: number, contentField: number): Criterion => ({
      link: "AND",
      criteria: terms.flatMap((term, i) => [
        { link: i === 0 ? "AND" : "OR", field: nameField, searchtype: "contains", value: term } as Criterion,
        { link: "OR", field: contentField, searchtype: "contains", value: term } as Criterion,
      ]),
    });
    const pool = Math.min(50, q.limit * 5);
    const hits: SimilarHit[] = [];

    const score = (name: string, content: string) => scoreText(terms, name, content);

    if (q.includeKb) {
      try {
        const { rows } = await this.search("KnowbaseItem", {
          criteria: [termCriteria(KB_FIELDS.name, KB_FIELDS.answer)],
          display: [KB_FIELDS.name, KB_FIELDS.id, KB_FIELDS.answer],
          start: 0,
          limit: pool,
        });
        for (const r of rows) {
          const name = cleanCell(r[String(KB_FIELDS.name)]) ?? "";
          const body = htmlToText(r[String(KB_FIELDS.answer)]);
          hits.push({ kind: "kb_article", id: Number(r[String(KB_FIELDS.id)]), name, score: score(name, body), excerpt: excerpt(body) });
        }
      } catch (err) {
        if (!(err instanceof GlpiApiError) || err.status !== 401) throw err;
      }
    }

    const tickets = async (statuses: string[], kind: SimilarHit["kind"]) => {
      const { rows } = await this.search("Ticket", {
        criteria: [anyOf(ITIL_FIELDS.status, statuses), termCriteria(ITIL_FIELDS.name, ITIL_FIELDS.content)],
        display: [ITIL_FIELDS.name, ITIL_FIELDS.id, ITIL_FIELDS.status, ITIL_FIELDS.date, ITIL_FIELDS.content],
        sort: ITIL_FIELDS.dateMod,
        order: "DESC",
        start: 0,
        limit: pool,
      });
      for (const r of rows) {
        const name = cleanCell(r[String(ITIL_FIELDS.name)]) ?? "";
        const body = htmlToText(r[String(ITIL_FIELDS.content)]);
        hits.push({
          kind,
          id: Number(r[String(ITIL_FIELDS.id)]),
          name,
          score: score(name, body),
          status: label(STATUS_LABELS, r[String(ITIL_FIELDS.status)]),
          date: cleanCell(r[String(ITIL_FIELDS.date)]),
          excerpt: excerpt(body),
        });
      }
    };
    if (q.includeOpen) await tickets(["notold"], "open_ticket");
    if (q.includeSolved) await tickets(["5", "6"], "solved_ticket");

    const ranked = hits.filter((h) => h.score > 0).sort((a, b) => b.score - a.score).slice(0, q.limit);

    // Show how the best solved matches were fixed.
    const solved = ranked.filter((h) => h.kind === "solved_ticket").slice(0, 3);
    await Promise.all(
      solved.map(async (h) => {
        try {
          const { body } = await this.request<Record<string, unknown>[]>("GET", `Ticket/${h.id}/ITILSolution`);
          const last = Array.isArray(body) && body.length ? body[body.length - 1] : undefined;
          if (last) (h as SimilarHit & { solution?: string }).solution = excerpt(htmlToText(last.content), 500);
        } catch {
          /* solution is a bonus */
        }
      }),
    );
    return ranked;
  }

  // ------------------------------------------------------------ documents

  async listDocuments(itemtype: string, id: number): Promise<DocumentInfo[]> {
    assertItemtype(itemtype);
    const { body } = await this.request<Record<string, unknown>>("GET", `${itemtype}/${id}`, {
      query: { with_documents: true },
    });
    const docs = body?._documents;
    if (!Array.isArray(docs)) return [];
    return docs.map((d: Record<string, unknown>) => ({
      id: Number(d.id),
      name: d.name as string | undefined,
      filename: d.filename as string | undefined,
      mime: d.mime as string | undefined,
      date: (d.assocdate ?? d.date_creation ?? d.date_mod) as string | undefined,
    }));
  }

  async downloadDocument(id: number, maxBytes: number): Promise<DownloadedDocument> {
    const meta = await this.request<Record<string, unknown>>("GET", `Document/${id}`);
    const filename = String(meta.body?.filename || meta.body?.name || `document-${id}`);
    const mime = String(meta.body?.mime || "application/octet-stream");
    const res = await this.request<Buffer>("GET", `Document/${id}`, { query: { alt: "media" }, binary: true, maxBytes });
    return { id, filename, mime, bytes: res.body };
  }

  async uploadDocument(itemtype: string, id: number, filename: string, mime: string, bytes: Buffer): Promise<unknown> {
    assertItemtype(itemtype);
    const safeName = filename.replace(/[\\/\0]/g, "_").slice(0, 200) || "upload.bin";
    const form = new FormData();
    const manifest = { input: { name: safeName, _filename: [safeName], itemtype, items_id: id } };
    form.append("uploadManifest", new Blob([JSON.stringify(manifest)], { type: "application/json" }));
    form.append("filename[0]", new Blob([new Uint8Array(bytes)], { type: mime }), safeName);
    const { body } = await this.request("POST", "Document", { form });
    return body;
  }

  // ----------------------------------------------------------- approvals

  private validationLink(itilType: ItilType) {
    const links = ITIL_LINKS[itilType];
    if (!links.validation) throw new Error(`${itilType} has no approvals in GLPI (only Ticket and Change)`);
    return { itemtype: links.validation, fk: links.fk };
  }

  private toValidation(itilType: ItilType, fk: string, v: Record<string, unknown>): ValidationItem {
    const names = (v._keys_names ?? {}) as Record<string, unknown>;
    return {
      validation_id: Number(v.id),
      itil_type: itilType,
      item_id: Number(v[fk]),
      item_name: names[fk] as string | undefined,
      status: VALIDATION_STATUS[Number(v.status)] ?? String(v.status),
      requested_by: names.users_id ?? v.users_id,
      validator: names.users_id_validate ?? v.users_id_validate,
      submission_date: v.submission_date as string | undefined,
      comment_submission: v.comment_submission ? htmlToText(v.comment_submission) : undefined,
      comment_validation: v.comment_validation ? htmlToText(v.comment_validation) : undefined,
      validation_date: (v.validation_date as string | null) ?? undefined,
    };
  }

  async listPendingValidations(itilType: ItilType, limit: number): Promise<ValidationItem[]> {
    const { itemtype, fk } = this.validationLink(itilType);
    const me = await this.session();
    // searchText is a LIKE filter, so exact matching is done here.
    const { body } = await this.request<Record<string, unknown>[]>("GET", itemtype, {
      query: {
        searchText: { users_id_validate: me.userId, status: 2 },
        add_keys_names: [fk, "users_id", "users_id_validate"],
        sort: "submission_date",
        order: "ASC",
        range: "0-999",
      },
    });
    return (Array.isArray(body) ? body : [])
      .filter((v) => Number(v.users_id_validate) === me.userId && Number(v.status) === 2)
      .slice(0, limit)
      .map((v) => this.toValidation(itilType, fk, v));
  }

  async listValidations(itilType: ItilType, id: number): Promise<ValidationItem[]> {
    const { itemtype, fk } = this.validationLink(itilType);
    const { body } = await this.request<Record<string, unknown>[]>("GET", `${itilType}/${id}/${itemtype}`, {
      query: { add_keys_names: ["users_id", "users_id_validate"] },
    });
    return (Array.isArray(body) ? body : []).map((v) => this.toValidation(itilType, fk, v));
  }

  async requestValidation(itilType: ItilType, id: number, validatorUserId: number, comment?: string): Promise<unknown> {
    const { itemtype, fk } = this.validationLink(itilType);
    const input: Record<string, unknown> = { [fk]: id, users_id_validate: validatorUserId };
    if (comment) input.comment_submission = comment;
    const { body } = await this.request("POST", itemtype, { body: { input } });
    return body;
  }

  async answerValidation(
    itilType: ItilType,
    validationId: number,
    decision: ValidationDecision,
    comment?: string,
  ): Promise<unknown> {
    const { itemtype } = this.validationLink(itilType);
    if (decision === "refuse" && !comment?.trim()) throw new Error("GLPI requires a reason to refuse an approval");
    const input: Record<string, unknown> = { status: decision === "approve" ? 3 : 4 };
    if (comment) input.comment_validation = comment;
    const { body } = await this.request("PUT", `${itemtype}/${validationId}`, { body: { input } });
    return body;
  }

  // --------------------------------------------------------- asset context

  async assetContext(itemtype: string, id: number, ticketLimit: number): Promise<unknown> {
    assertItemtype(itemtype);
    const { body } = await this.request<Record<string, unknown>>("GET", `${itemtype}/${id}`, {
      query: { expand_dropdowns: true, with_tickets: true },
    });
    const raw = Array.isArray(body?._tickets) ? (body._tickets as Record<string, unknown>[]) : [];
    const tickets = raw
      .map((t) => ({
        id: Number(t.id),
        name: t.name as string | undefined,
        status: label(STATUS_LABELS, t.status),
        date: t.date as string | undefined,
        solvedate: (t.solvedate as string | null) ?? undefined,
        open: ![5, 6].includes(Number(t.status)),
      }))
      .sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
    const { _tickets: _ignored, links: _links, ...item } = body ?? {};
    const keep = [
      "id", "name", "serial", "otherserial", "contact", "comment", "date_mod", "users_id", "groups_id",
      "users_id_tech", "groups_id_tech", "locations_id", "states_id", "manufacturers_id", "entities_id",
    ];
    const summary = Object.fromEntries(
      Object.entries(textifyRecord(item)).filter(([k, v]) => (keep.includes(k) || /models_id$|types_id$/.test(k)) && v !== "" && v !== null && v !== 0),
    );
    return {
      itemtype,
      item: summary,
      tickets: {
        total: tickets.length,
        open: tickets.filter((t) => t.open).length,
        recent: tickets.slice(0, ticketLimit),
      },
    };
  }

  // ---------------------------------------------------------------- stats

  async itilStats(q: StatsQuery): Promise<unknown> {
    const dayBefore = new Date(`${q.from}T00:00:00Z`);
    dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
    const criteria: Criterion[] = [
      { link: "AND", field: ITIL_FIELDS.date, searchtype: "morethan", value: `${dayBefore.toISOString().slice(0, 10)} 23:59:59` },
      { link: "AND", field: ITIL_FIELDS.date, searchtype: "lessthan", value: `${q.to} 23:59:59` },
    ];
    if (q.assignedGroupId !== undefined) {
      criteria.push({ link: "AND", field: ITIL_FIELDS.assignedGroup, searchtype: "equals", value: q.assignedGroupId });
    }
    if (q.categoryId !== undefined) {
      criteria.push({ link: "AND", field: ITIL_FIELDS.category, searchtype: "equals", value: q.categoryId });
    }
    const isTicket = q.itilType === "Ticket";
    const display = [
      ITIL_FIELDS.id, ITIL_FIELDS.status, ITIL_FIELDS.priority, ITIL_FIELDS.category, ITIL_FIELDS.assignedGroup,
      ITIL_FIELDS.date, ITIL_FIELDS.solveDate, ITIL_FIELDS.timeToResolve, ITIL_FIELDS.solveDelay,
      ...(isTicket ? [ITIL_FIELDS.type, ITIL_FIELDS.timeToOwn, ITIL_FIELDS.takeIntoAccountDelay] : []),
    ];
    const rows: StatsRow[] = [];
    let total = 0;
    const page = 500;
    for (let start = 0; start < q.maxRows; start += page) {
      const res = await this.search(q.itilType, {
        criteria,
        display,
        sort: ITIL_FIELDS.date,
        order: "ASC",
        start,
        limit: Math.min(page, q.maxRows - start),
      });
      total = res.total;
      for (const r of res.rows) {
        const g = (id: number) => r[String(id)];
        rows.push({
          status: Number(g(ITIL_FIELDS.status)),
          priority: Number(g(ITIL_FIELDS.priority)),
          type: isTicket ? Number(g(ITIL_FIELDS.type)) : undefined,
          category: cleanCell(g(ITIL_FIELDS.category)),
          group: cleanCell(g(ITIL_FIELDS.assignedGroup)),
          date: cleanCell(g(ITIL_FIELDS.date)),
          solveDate: cleanCell(g(ITIL_FIELDS.solveDate)),
          timeToResolve: cleanCell(g(ITIL_FIELDS.timeToResolve)),
          timeToOwn: isTicket ? cleanCell(g(ITIL_FIELDS.timeToOwn)) : undefined,
          solveDelay: numberOrUndefined(g(ITIL_FIELDS.solveDelay)),
          takeIntoAccountDelay: isTicket ? numberOrUndefined(g(ITIL_FIELDS.takeIntoAccountDelay)) : undefined,
        });
      }
      if (start + page >= total) break;
    }
    return computeItilStats(q, rows, total);
  }
}

// ------------------------------------------------------------------ helpers

function anyOf(field: number, values: Array<string | number>): Criterion {
  return {
    link: "AND",
    criteria: values.map((v, i) => ({ link: i === 0 ? "AND" : "OR", field, searchtype: "equals", value: v })),
  };
}

function dedupeSla(items: SlaItem[]): SlaItem[] {
  const seen = new Map<number, SlaItem>();
  for (const it of items) {
    const prev = seen.get(it.id);
    if (!prev || it.due < prev.due) seen.set(it.id, it);
  }
  return [...seen.values()];
}

function numberOrUndefined(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(Array.isArray(v) ? v[0] : v);
  return Number.isFinite(n) ? n : undefined;
}

function setIf(target: Record<string, unknown>, key: string, value: unknown) {
  if (value !== undefined && value !== null) target[key] = value;
}

/** Search results may hold HTML (links), entities, or arrays for multi-valued fields. */
export function cleanCell(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (Array.isArray(value)) return value.map((v) => cleanCell(v)).filter(Boolean).join(", ") || undefined;
  return (
    stripTags(decodeEntities(String(value)))
      .replace(/\$\$\$\$/g, ", ")
      .replace(/\s+/g, " ")
      .trim() || undefined
  );
}

function isSessionError(body: unknown): boolean {
  return Array.isArray(body) && typeof body[0] === "string" && /SESSION_TOKEN/i.test(body[0]);
}
