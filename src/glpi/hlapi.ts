/**
 * Backend for the High-Level API (/api.php) of GLPI 11 and later.
 *
 * Auth: OAuth2 password grant against /api.php/token (create the client in
 * Setup > OAuth clients with the Password grant and the "api" scope).
 * The API version is pinned in every path, because GLPI silently routes an
 * unknown or missing version to its newest one and schemas differ between
 * majors (2.x on GLPI 11, 3.x on GLPI 12).
 */
import type { Config } from "../config.js";
import { excerpt, htmlToText, textifyRecord } from "../text.js";
import { GlpiApiError, httpRequest, toPhpQuery, totalFromContentRange, type FetchLike } from "./http.js";
import { keywords, scoreText } from "./similar.js";
import {
  UnsupportedFeatureError,
  type DocumentInfo,
  type DownloadedDocument,
  type QueueQuery,
  type SessionInfo,
  type SimilarHit,
  type SimilarQuery,
  type SlaItem,
  type SlaQuery,
  type StatsQuery,
  type ValidationDecision,
  type ValidationItem,
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

/** Legacy itemtype names (used by the tools) -> High-Level API paths. */
export const HLAPI_PATHS: Record<string, string> = {
  Ticket: "Assistance/Ticket",
  Change: "Assistance/Change",
  Problem: "Assistance/Problem",
  Computer: "Assets/Computer",
  Monitor: "Assets/Monitor",
  NetworkEquipment: "Assets/NetworkEquipment",
  Peripheral: "Assets/Peripheral",
  Phone: "Assets/Phone",
  Printer: "Assets/Printer",
  Software: "Assets/Software",
  Rack: "Assets/Rack",
  Enclosure: "Assets/Enclosure",
  PDU: "Assets/PDU",
  Cartridge: "Assets/Cartridge",
  Consumable: "Assets/Consumable",
  User: "Administration/User",
  Group: "Administration/Group",
  Entity: "Administration/Entity",
  Profile: "Administration/Profile",
  KnowbaseItem: "Knowledgebase/Article",
  KnowbaseItemCategory: "Knowledgebase/Category",
  Document: "Management/Document",
  Contract: "Management/Contract",
  Supplier: "Management/Supplier",
  Budget: "Management/Budget",
  License: "Management/License",
  Location: "Dropdowns/Location",
  State: "Dropdowns/State",
  Manufacturer: "Dropdowns/Manufacturer",
  ITILCategory: "Dropdowns/ITILCategory",
  Project: "Project",
};

export function hlapiPath(itemtype: string): string {
  const path = HLAPI_PATHS[itemtype];
  if (!path) {
    throw new Error(
      `Itemtype "${itemtype}" is not mapped for the High-Level API. Supported: ${Object.keys(HLAPI_PATHS).join(", ")}. ` +
        "Use glpi_raw_get with the High-Level API path, or GLPI_API_MODE=legacy.",
    );
  }
  return path;
}

interface ApiVersion {
  version?: string;
  api_version?: string;
}

/** Pick the version to pin: the requested one, or the newest 2.x, or the newest offered. */
export function pickVersion(offered: ApiVersion[], requested: string): string {
  const available = offered
    .map((v) => String(v.version ?? v.api_version ?? "").match(/^(\d+)\.(\d+)/))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map((m) => ({ major: Number(m[1]), minor: Number(m[2]), id: `${m[1]}.${m[2]}` }));
  if (!available.length) throw new Error("GLPI lists no High-Level API versions");
  if (requested !== "auto") {
    if (!available.some((v) => v.id === requested)) {
      throw new Error(`GLPI does not offer High-Level API ${requested} (offers ${available.map((v) => v.id).join(", ")})`);
    }
    return requested;
  }
  const sorted = [...available].sort((a, b) => b.major - a.major || b.minor - a.minor);
  return (sorted.find((v) => v.major === 2) ?? sorted[0]).id;
}

/** Quote an RSQL value when it holds reserved characters or spaces. */
export function rsqlValue(value: string | number): string {
  const s = String(value);
  if (/^[\w*.@:+-]+$/.test(s)) return s;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export class HlapiBackend implements GlpiBackend {
  readonly kind = "hlapi" as const;
  private readonly root: string;
  private version?: string;
  private offered?: ApiVersion[];
  private token?: { value: string; expiresAt: number };
  private tokenPromise?: Promise<string>;

  constructor(
    private readonly config: Config,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.root = `${config.glpiUrl}/api.php`;
  }

  // -------------------------------------------------------------- discovery

  async listVersions(): Promise<ApiVersion[]> {
    if (this.offered) return this.offered;
    const res = await httpRequest<{ api_versions?: ApiVersion[] }>(this.fetchImpl, `${this.root}/`, {
      method: "GET",
      headers: { Accept: "application/json" },
      timeoutMs: this.config.timeoutMs,
    });
    if (res.status >= 400 || !Array.isArray(res.body?.api_versions)) {
      throw new GlpiApiError(res.status, "GET", "api.php/", res.body ?? "no api_versions listed (GLPI 10 or older?)");
    }
    this.offered = res.body!.api_versions!;
    return this.offered;
  }

  async pinnedVersion(): Promise<string> {
    this.version ??= pickVersion(await this.listVersions(), this.config.hlapiVersion);
    return this.version;
  }

  // ------------------------------------------------------------------ auth

  private async grant(): Promise<string> {
    const o = this.config.oauth;
    const form = new URLSearchParams({
      grant_type: "password",
      client_id: o.clientId ?? "",
      client_secret: o.clientSecret ?? "",
      username: o.username ?? "",
      password: o.password ?? "",
      scope: o.scope,
    });
    const res = await httpRequest<{ access_token?: string; expires_in?: number }>(this.fetchImpl, `${this.root}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form.toString(),
      timeoutMs: this.config.timeoutMs,
    });
    if (res.status >= 400 || !res.body?.access_token) {
      throw new GlpiApiError(res.status, "POST", "api.php/token", res.body);
    }
    const lifetime = Number(res.body.expires_in ?? 3600);
    this.token = { value: res.body.access_token, expiresAt: Date.now() + Math.max(lifetime - 60, 30) * 1000 };
    return this.token.value;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    this.tokenPromise ??= this.grant().finally(() => {
      this.tokenPromise = undefined;
    });
    return this.tokenPromise;
  }

  async request<T = unknown>(
    method: string,
    path: string,
    opts: { query?: Record<string, unknown>; body?: unknown } = {},
  ): Promise<{ body: T; headers: Headers; status: number }> {
    const version = await this.pinnedVersion();
    const qs = opts.query ? toPhpQuery(opts.query) : "";
    const url = `${this.root}/v${version}/${path.replace(/^\/+/, "")}${qs ? `?${qs}` : ""}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken();
      const res = await httpRequest<T>(this.fetchImpl, url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        timeoutMs: this.config.timeoutMs,
      });
      if (attempt === 0 && isTokenRejection(res.status, res.body)) {
        this.token = undefined;
        continue;
      }
      if (res.status >= 400) throw new GlpiApiError(res.status, method, path, res.body);
      return res;
    }
    throw new Error("unreachable");
  }

  async close(): Promise<void> {
    this.token = undefined;
  }

  async describe(): Promise<Record<string, unknown>> {
    const offered = await this.listVersions();
    return {
      api: "hlapi",
      endpoint: this.root,
      pinned_version: await this.pinnedVersion(),
      offered_versions: offered.map((v) => v.version ?? v.api_version),
    };
  }

  async whoami(): Promise<unknown> {
    const { body } = await this.request("GET", "Administration/User/Me");
    return body;
  }

  // ------------------------------------------------------------------ ITIL

  async listItil(q: ItilQuery): Promise<Page<ItilSummary>> {
    if (q.assignedUserId !== undefined || q.assignedGroupId !== undefined || q.requesterUserId !== undefined) {
      throw new Error(
        "The High-Level API cannot filter by requester or assignee (the team is computed per item). " +
          "Filter by other fields, or run the server with GLPI_API_MODE=legacy for that filter.",
      );
    }
    const clauses: string[] = [];
    if (q.statuses?.length) clauses.push(`status.id=in=(${q.statuses.join(",")})`);
    else if (q.openOnly) clauses.push("status.id=out=(5,6)");
    if (q.priorities?.length) clauses.push(`priority=in=(${q.priorities.join(",")})`);
    if (q.ticketType !== undefined) {
      if (q.itilType !== "Ticket") throw new Error("ticket_type applies to tickets only");
      clauses.push(`type==${q.ticketType}`);
    }
    if (q.categoryId !== undefined) clauses.push(`category.id==${q.categoryId}`);
    if (q.text) clauses.push(`(name=ilike=${rsqlValue(`*${q.text}*`)},content=ilike=${rsqlValue(`*${q.text}*`)})`);

    const res = await this.request<Record<string, unknown>[]>("GET", hlapiPath(q.itilType), {
      query: {
        filter: clauses.length ? clauses.join(";") : undefined,
        sort: "date_mod:desc",
        start: q.start,
        limit: q.limit,
      },
    });
    const rows = Array.isArray(res.body) ? res.body : [];
    return {
      start: q.start,
      limit: q.limit,
      total: totalFromContentRange(res.headers),
      items: rows.map((r) => ({
        id: Number(r.id),
        name: String(r.name ?? ""),
        status: label(STATUS_LABELS, r.status),
        priority: label(PRIORITY_LABELS, r.priority),
        type: q.itilType === "Ticket" ? label(TICKET_TYPE_LABELS, r.type) : undefined,
        category: nameOf(r.category),
        date_creation: (r.date_creation ?? r.date) as string | undefined,
        date_mod: r.date_mod as string | undefined,
      })),
    };
  }

  async getItil(itilType: ItilType, id: number): Promise<unknown> {
    const { body } = await this.request<Record<string, unknown>>("GET", `${hlapiPath(itilType)}/${id}`);
    return {
      ...textifyRecord(body),
      status_label: label(STATUS_LABELS, body?.status),
      priority_label: label(PRIORITY_LABELS, body?.priority),
    };
  }

  async getItilTimeline(itilType: ItilType, id: number): Promise<unknown> {
    const { body } = await this.request<unknown[]>("GET", `${hlapiPath(itilType)}/${id}/Timeline`);
    const entries = Array.isArray(body)
      ? body.map((e) => {
          const entry = e as Record<string, unknown>;
          return entry.item && typeof entry.item === "object" ? { ...entry, item: textifyRecord(entry.item) } : textifyRecord(entry);
        })
      : body;
    return { itil_type: itilType, id, entries };
  }

  async getItilTeam(itilType: ItilType, id: number): Promise<unknown> {
    const { body } = await this.request("GET", `${hlapiPath(itilType)}/${id}/TeamMember`);
    return body;
  }

  async createItil(input: ItilCreateInput): Promise<unknown> {
    const payload: Record<string, unknown> = { name: input.name, content: input.content };
    if (input.itilType === "Ticket") setIf(payload, "type", input.ticketType);
    setIf(payload, "urgency", input.urgency);
    setIf(payload, "impact", input.impact);
    setIf(payload, "priority", input.priority);
    setIf(payload, "category", input.categoryId);
    setIf(payload, "entity", input.entityId);
    setIf(payload, "location", input.locationId);
    const res = await this.request<Record<string, unknown>>("POST", hlapiPath(input.itilType), { body: payload });
    const id = Number(res.body?.id ?? res.headers.get("location")?.match(/\/(\d+)\/?$/)?.[1]);
    const team: Array<[TeamMemberType, number | undefined, TeamRole]> = [
      ["User", input.requesterUserId, "requester"],
      ["User", input.assignedUserId, "assigned"],
      ["Group", input.assignedGroupId, "assigned"],
    ];
    const teamResults: unknown[] = [];
    if (Number.isFinite(id)) {
      for (const [type, memberId, role] of team) {
        if (memberId === undefined) continue;
        try {
          await this.addTeamMember(input.itilType, id, type, memberId, role);
          teamResults.push({ type, id: memberId, role, ok: true });
        } catch (err) {
          teamResults.push({ type, id: memberId, role, ok: false, error: (err as Error).message });
        }
      }
    }
    return { ...(res.body ?? {}), id: Number.isFinite(id) ? id : res.body?.id, team: teamResults.length ? teamResults : undefined };
  }

  async updateItil(itilType: ItilType, id: number, f: ItilUpdateInput): Promise<unknown> {
    const payload: Record<string, unknown> = { ...(f.extra ?? {}) };
    setIf(payload, "name", f.name);
    setIf(payload, "content", f.content);
    setIf(payload, "status", f.status);
    setIf(payload, "urgency", f.urgency);
    setIf(payload, "impact", f.impact);
    setIf(payload, "priority", f.priority);
    setIf(payload, "category", f.categoryId);
    setIf(payload, "location", f.locationId);
    if (itilType === "Ticket") setIf(payload, "type", f.ticketType);
    if (!Object.keys(payload).length) throw new Error("Nothing to update: give at least one field");
    const { body } = await this.request("PATCH", `${hlapiPath(itilType)}/${id}`, { body: payload });
    return body;
  }

  async addFollowup(itilType: ItilType, id: number, content: string, isPrivate: boolean): Promise<unknown> {
    const { body } = await this.request("POST", `${hlapiPath(itilType)}/${id}/Timeline/Followup`, {
      body: { content, is_private: isPrivate },
    });
    return body;
  }

  async addTask(itilType: ItilType, id: number, t: TaskInput): Promise<unknown> {
    const payload: Record<string, unknown> = { content: t.content, is_private: t.isPrivate };
    setIf(payload, "state", t.state);
    setIf(payload, "duration", t.durationSeconds);
    setIf(payload, "user_tech", t.techUserId);
    const { body } = await this.request("POST", `${hlapiPath(itilType)}/${id}/Timeline/Task`, { body: payload });
    return body;
  }

  async addSolution(itilType: ItilType, id: number, content: string): Promise<unknown> {
    const { body } = await this.request("POST", `${hlapiPath(itilType)}/${id}/Timeline/Solution`, {
      body: { content },
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
    const { body } = await this.request("POST", `${hlapiPath(itilType)}/${id}/TeamMember`, {
      body: { type: memberType, id: memberId, role },
    });
    return body;
  }

  // --------------------------------------------------------------- generic

  async searchItems(itemtype: string, text: string, start: number, limit: number): Promise<Page<ItemRef>> {
    const field = itemtype === "User" ? "username" : "name";
    const filter =
      itemtype === "User"
        ? `(username=ilike=${rsqlValue(`*${text}*`)},firstname=ilike=${rsqlValue(`*${text}*`)},realname=ilike=${rsqlValue(`*${text}*`)})`
        : `${field}=ilike=${rsqlValue(`*${text}*`)}`;
    const res = await this.request<Record<string, unknown>[]>("GET", hlapiPath(itemtype), {
      query: { filter, start, limit },
    });
    const rows = Array.isArray(res.body) ? res.body : [];
    return {
      start,
      limit,
      total: totalFromContentRange(res.headers),
      items: rows.map((r) => ({
        id: Number(r.id),
        name: String(r.name ?? r.username ?? ""),
        entity: nameOf(r.entity),
        ...(itemtype === "User" ? { firstname: r.firstname, realname: r.realname } : {}),
      })),
    };
  }

  async listItems(itemtype: string, start: number, limit: number): Promise<Page<unknown>> {
    const res = await this.request<unknown[]>("GET", hlapiPath(itemtype), { query: { start, limit } });
    return { start, limit, total: totalFromContentRange(res.headers), items: Array.isArray(res.body) ? res.body : [] };
  }

  async getItem(itemtype: string, id: number): Promise<unknown> {
    const { body } = await this.request("GET", `${hlapiPath(itemtype)}/${id}`);
    return body;
  }

  async createItem(itemtype: string, fields: Record<string, unknown>): Promise<unknown> {
    const { body } = await this.request("POST", hlapiPath(itemtype), { body: fields });
    return body;
  }

  async updateItem(itemtype: string, id: number, fields: Record<string, unknown>): Promise<unknown> {
    const { body } = await this.request("PATCH", `${hlapiPath(itemtype)}/${id}`, { body: fields });
    return body;
  }

  async deleteItem(itemtype: string, id: number, purge: boolean): Promise<unknown> {
    const { body } = await this.request("DELETE", `${hlapiPath(itemtype)}/${id}`, {
      query: purge ? { force: true } : undefined,
    });
    return body ?? { deleted: true };
  }

  async rawGet(path: string, query?: Record<string, unknown>): Promise<unknown> {
    const clean = path.replace(/^\/*(api\.php\/)?(v\d+(\.\d+)?\/)?/, "");
    if (clean.includes("..")) throw new Error("Invalid path");
    const res = await this.request("GET", clean, { query });
    return { status: res.status, total: totalFromContentRange(res.headers), body: res.body };
  }

  // --- Experience features. The High-Level API covers fewer of them; the tool
  // layer retries on the legacy API when legacy credentials are configured.

  async session(): Promise<SessionInfo> {
    const { body } = await this.request<Record<string, unknown>>("GET", "Administration/User/Me");
    const name = [body?.firstname, body?.realname].filter(Boolean).join(" ").trim();
    return {
      userId: Number(body?.id),
      login: (body?.username ?? body?.name) as string | undefined,
      name: name || undefined,
      groupIds: [],
    };
  }

  async myQueue(_q: QueueQuery): Promise<Page<ItilSummary>> {
    throw new UnsupportedFeatureError("Filtering by assigned technician or group");
  }

  async slaAtRisk(_q: SlaQuery): Promise<{ overdue: SlaItem[]; due_soon: SlaItem[]; window_hours: number }> {
    throw new UnsupportedFeatureError("SLA due dates");
  }

  async findSimilar(q: SimilarQuery): Promise<SimilarHit[]> {
    const terms = keywords(q.text);
    if (!terms.length) throw new Error("The text has no searchable words; describe the problem in more detail");
    const anyTerm = (fields: string[]) =>
      `(${terms.flatMap((t) => fields.map((f) => `${f}=ilike=${rsqlValue(`*${t}*`)}`)).join(",")})`;
    const pool = Math.min(50, q.limit * 5);
    const hits: SimilarHit[] = [];
    const list = async (path: string, filter: string) => {
      const res = await this.request<Record<string, unknown>[]>("GET", path, { query: { filter, start: 0, limit: pool } });
      return Array.isArray(res.body) ? res.body : [];
    };
    if (q.includeKb) {
      for (const r of await list(hlapiPath("KnowbaseItem"), anyTerm(["name", "content"]))) {
        const name = String(r.name ?? "");
        const body = htmlToText(r.content ?? r.answer);
        hits.push({ kind: "kb_article", id: Number(r.id), name, score: scoreText(terms, name, body), excerpt: excerpt(body) });
      }
    }
    const tickets = async (status: string, kind: SimilarHit["kind"]) => {
      for (const r of await list(hlapiPath("Ticket"), `${status};${anyTerm(["name", "content"])}`)) {
        const name = String(r.name ?? "");
        const body = htmlToText(r.content);
        hits.push({
          kind,
          id: Number(r.id),
          name,
          score: scoreText(terms, name, body),
          status: label(STATUS_LABELS, r.status),
          date: (r.date_creation ?? r.date) as string | undefined,
          excerpt: excerpt(body),
        });
      }
    };
    if (q.includeOpen) await tickets("status.id=out=(5,6)", "open_ticket");
    if (q.includeSolved) await tickets("status.id=in=(5,6)", "solved_ticket");
    return hits.filter((h) => h.score > 0).sort((a, b) => b.score - a.score).slice(0, q.limit);
  }

  async listDocuments(_itemtype: string, _id: number): Promise<DocumentInfo[]> {
    throw new UnsupportedFeatureError("Listing attachments");
  }

  async downloadDocument(_id: number, _maxBytes: number): Promise<DownloadedDocument> {
    throw new UnsupportedFeatureError("Downloading attachments");
  }

  async uploadDocument(_itemtype: string, _id: number, _f: string, _m: string, _b: Buffer): Promise<unknown> {
    throw new UnsupportedFeatureError("Uploading attachments");
  }

  async listPendingValidations(_itilType: ItilType, _limit: number): Promise<ValidationItem[]> {
    throw new UnsupportedFeatureError("Approvals");
  }

  async listValidations(_itilType: ItilType, _id: number): Promise<ValidationItem[]> {
    throw new UnsupportedFeatureError("Approvals");
  }

  async requestValidation(_itilType: ItilType, _id: number, _validator: number, _comment?: string): Promise<unknown> {
    throw new UnsupportedFeatureError("Approvals");
  }

  async answerValidation(_itilType: ItilType, _id: number, _d: ValidationDecision, _c?: string): Promise<unknown> {
    throw new UnsupportedFeatureError("Approvals");
  }

  async assetContext(_itemtype: string, _id: number, _limit: number): Promise<unknown> {
    throw new UnsupportedFeatureError("Asset ticket history");
  }

  async itilStats(_q: StatsQuery): Promise<unknown> {
    throw new UnsupportedFeatureError("Service desk statistics");
  }
}

function setIf(target: Record<string, unknown>, key: string, value: unknown) {
  if (value !== undefined && value !== null) target[key] = value;
}

function nameOf(value: unknown): string | undefined {
  if (value && typeof value === "object") {
    const v = value as { name?: unknown; completename?: unknown };
    return (v.completename ?? v.name) as string | undefined;
  }
  return value === null || value === undefined ? undefined : String(value);
}

/** GLPI answers 400 "Invalid OAuth token" (not only 401) for an expired token. */
function isTokenRejection(status: number, body: unknown): boolean {
  if (status === 401) return true;
  if (status !== 400 || !body || typeof body !== "object") return false;
  return /oauth token/i.test(String((body as { title?: unknown }).title ?? ""));
}
