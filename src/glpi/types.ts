/**
 * The contract every GLPI backend (legacy REST API or High-Level API) fulfils,
 * so the MCP tools stay the same whatever GLPI version is behind them.
 */

export type ItilType = "Ticket" | "Change" | "Problem";

export const ITIL_TYPES = ["Ticket", "Change", "Problem"] as const;

export const STATUS_LABELS: Record<number, string> = {
  1: "new",
  2: "processing (assigned)",
  3: "processing (planned)",
  4: "pending",
  5: "solved",
  6: "closed",
};

export const PRIORITY_LABELS: Record<number, string> = {
  1: "very low",
  2: "low",
  3: "medium",
  4: "high",
  5: "very high",
  6: "major",
};

export const TICKET_TYPE_LABELS: Record<number, string> = { 1: "incident", 2: "request" };

export interface ItilQuery {
  itilType: ItilType;
  /** Status IDs to include (1-6). */
  statuses?: number[];
  /** Exclude solved and closed. Ignored when statuses is given. */
  openOnly?: boolean;
  /** Free text on title (and content where the API allows). */
  text?: string;
  priorities?: number[];
  ticketType?: number;
  categoryId?: number;
  assignedUserId?: number;
  assignedGroupId?: number;
  requesterUserId?: number;
  start: number;
  limit: number;
}

export interface ItilSummary {
  id: number;
  name: string;
  status?: string;
  priority?: string;
  type?: string;
  category?: string;
  date_creation?: string;
  date_mod?: string;
  requester?: string;
  assigned_user?: string;
  assigned_group?: string;
}

export interface Page<T> {
  items: T[];
  total?: number;
  start: number;
  limit: number;
}

export interface ItilCreateInput {
  itilType: ItilType;
  name: string;
  content: string;
  ticketType?: number;
  urgency?: number;
  impact?: number;
  priority?: number;
  categoryId?: number;
  entityId?: number;
  locationId?: number;
  requesterUserId?: number;
  assignedUserId?: number;
  assignedGroupId?: number;
}

/** Common fields, mapped by each backend to its own field names. */
export interface ItilUpdateInput {
  name?: string;
  content?: string;
  status?: number;
  urgency?: number;
  impact?: number;
  priority?: number;
  ticketType?: number;
  categoryId?: number;
  locationId?: number;
  /** Extra fields passed as-is, in the backend's own field names. */
  extra?: Record<string, unknown>;
}

export interface TaskInput {
  content: string;
  isPrivate: boolean;
  /** 0 information, 1 to do, 2 done. */
  state?: number;
  durationSeconds?: number;
  techUserId?: number;
}

export type TeamRole = "requester" | "assigned" | "observer";
export type TeamMemberType = "User" | "Group";

export interface ItemRef {
  id: number;
  name?: string;
  [key: string]: unknown;
}

/** Thrown when the active API cannot do something; the tool layer may retry on the legacy API. */
export class UnsupportedFeatureError extends Error {
  constructor(feature: string, hint = "Run the server with legacy API credentials (GLPI_USER_TOKEN) for this feature.") {
    super(`${feature} is not available on the GLPI High-Level API. ${hint}`);
  }
}

export interface SessionInfo {
  userId: number;
  login?: string;
  name?: string;
  groupIds: number[];
  profile?: string;
  entity?: string;
}

export interface QueueQuery {
  itilType: ItilType;
  /** Include items assigned to the user's groups, not only to the user. */
  includeGroups: boolean;
  statuses?: number[];
  start: number;
  limit: number;
}

export type SlaKind = "resolve" | "own";

export interface SlaQuery {
  kinds: SlaKind[];
  /** Look-ahead window for "due soon". */
  withinHours: number;
  /** Also use the internal targets (OLA) when set. */
  includeOla: boolean;
  assignedGroupId?: number;
  assignedUserId?: number;
  limit: number;
}

export interface SlaItem extends ItilSummary {
  target: "time_to_resolve" | "time_to_own" | "internal_time_to_resolve" | "internal_time_to_own";
  due: string;
  state: "overdue" | "due_soon";
}

export interface SimilarQuery {
  text: string;
  includeKb: boolean;
  includeOpen: boolean;
  includeSolved: boolean;
  limit: number;
}

export interface SimilarHit {
  kind: "kb_article" | "open_ticket" | "solved_ticket";
  id: number;
  name: string;
  score: number;
  status?: string;
  date?: string;
  excerpt?: string;
}

export interface DocumentInfo {
  id: number;
  name?: string;
  filename?: string;
  mime?: string;
  size?: number;
  date?: string;
}

export interface DownloadedDocument {
  id: number;
  filename: string;
  mime: string;
  bytes: Buffer;
}

export type ValidationDecision = "approve" | "refuse";

export interface ValidationItem {
  validation_id: number;
  itil_type: ItilType;
  item_id: number;
  item_name?: string;
  status: string;
  requested_by?: unknown;
  validator?: unknown;
  submission_date?: string;
  comment_submission?: string;
  comment_validation?: string;
  validation_date?: string;
}

export interface StatsQuery {
  itilType: ItilType;
  /** Inclusive, "YYYY-MM-DD". */
  from: string;
  /** Inclusive, "YYYY-MM-DD". */
  to: string;
  assignedGroupId?: number;
  categoryId?: number;
  /** Safety cap on rows read. */
  maxRows: number;
}

export interface GlpiBackend {
  readonly kind: "legacy" | "hlapi";
  /** API kind and version, for diagnostics. */
  describe(): Promise<Record<string, unknown>>;
  whoami(): Promise<unknown>;

  listItil(q: ItilQuery): Promise<Page<ItilSummary>>;
  getItil(itilType: ItilType, id: number): Promise<unknown>;
  getItilTimeline(itilType: ItilType, id: number): Promise<unknown>;
  getItilTeam(itilType: ItilType, id: number): Promise<unknown>;
  createItil(input: ItilCreateInput): Promise<unknown>;
  updateItil(itilType: ItilType, id: number, fields: ItilUpdateInput): Promise<unknown>;
  addFollowup(itilType: ItilType, id: number, content: string, isPrivate: boolean): Promise<unknown>;
  addTask(itilType: ItilType, id: number, task: TaskInput): Promise<unknown>;
  addSolution(itilType: ItilType, id: number, content: string): Promise<unknown>;
  addTeamMember(
    itilType: ItilType,
    id: number,
    memberType: TeamMemberType,
    memberId: number,
    role: TeamRole,
  ): Promise<unknown>;

  /** Find items of any supported itemtype by name. */
  searchItems(itemtype: string, text: string, start: number, limit: number): Promise<Page<ItemRef>>;
  listItems(itemtype: string, start: number, limit: number): Promise<Page<unknown>>;
  getItem(itemtype: string, id: number): Promise<unknown>;
  createItem(itemtype: string, fields: Record<string, unknown>): Promise<unknown>;
  updateItem(itemtype: string, id: number, fields: Record<string, unknown>): Promise<unknown>;
  deleteItem(itemtype: string, id: number, purge: boolean): Promise<unknown>;

  /** Read-only escape hatch for endpoints the tools do not cover. */
  rawGet(path: string, query?: Record<string, unknown>): Promise<unknown>;

  // --- Experience features (UnsupportedFeatureError when the API cannot do it)
  session(): Promise<SessionInfo>;
  myQueue(q: QueueQuery): Promise<Page<ItilSummary>>;
  slaAtRisk(q: SlaQuery): Promise<{ overdue: SlaItem[]; due_soon: SlaItem[]; window_hours: number }>;
  findSimilar(q: SimilarQuery): Promise<SimilarHit[]>;
  listDocuments(itemtype: string, id: number): Promise<DocumentInfo[]>;
  downloadDocument(id: number, maxBytes: number): Promise<DownloadedDocument>;
  uploadDocument(itemtype: string, id: number, filename: string, mime: string, bytes: Buffer): Promise<unknown>;
  listPendingValidations(itilType: ItilType, limit: number): Promise<ValidationItem[]>;
  listValidations(itilType: ItilType, id: number): Promise<ValidationItem[]>;
  requestValidation(itilType: ItilType, id: number, validatorUserId: number, comment?: string): Promise<unknown>;
  answerValidation(itilType: ItilType, validationId: number, decision: ValidationDecision, comment?: string): Promise<unknown>;
  assetContext(itemtype: string, id: number, ticketLimit: number): Promise<unknown>;
  itilStats(q: StatsQuery): Promise<unknown>;

  close(): Promise<void>;
}

export function label(map: Record<number, string>, value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const n = typeof value === "object" ? Number((value as { id?: unknown }).id) : Number(value);
  return map[n] ?? String(typeof value === "object" ? (value as { name?: unknown }).name ?? n : value);
}
