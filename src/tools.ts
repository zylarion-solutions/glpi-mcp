/**
 * MCP tools. They talk to a BackendSource, so they behave the same on the legacy
 * REST API and on the High-Level API (falling back to legacy where needed), and
 * with a shared service account or with each user's own GLPI identity.
 *
 * Safety: write tools are only registered when GLPI_READ_ONLY=false, and the
 * delete tool only when GLPI_ALLOW_DELETE=true as well.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "./config.js";
import type { BackendSource } from "./glpi/factory.js";
import { ITIL_TYPES, type GlpiBackend, type ItilType } from "./glpi/types.js";
import { resolveAll, resolveRef, type Ref } from "./resolve.js";

const MAX_TEXT = 100_000;

type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; mimeType: string; blob: string } };
export type ToolResult = { content: Content[]; isError?: boolean };

export function ok(data: unknown): ToolResult {
  let text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  if (text.length > MAX_TEXT) {
    text = `${text.slice(0, MAX_TEXT)}\n... [truncated ${text.length - MAX_TEXT} characters; narrow the query or lower the limit]`;
  }
  return { content: [{ type: "text", text }] };
}

export function fail(err: unknown): ToolResult {
  return { content: [{ type: "text", text: `Error: ${(err as Error)?.message ?? String(err)}` }], isError: true };
}

// ------------------------------------------------------------------ schemas

const itilType = z
  .enum(ITIL_TYPES)
  .default("Ticket")
  .describe("ITIL object: Ticket (default), Change or Problem");
const id = z.number().int().positive();
const level = z.number().int().min(1).max(5);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const ref = (what: string) =>
  z
    .union([z.number().int().positive(), z.string().min(1).max(200)])
    .describe(`${what}: numeric ID or name (a unique match is used; several matches return the candidates to choose from)`);
const itemtype = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/)
  .describe(
    "GLPI itemtype, e.g. Computer, Monitor, NetworkEquipment, Printer, Phone, Peripheral, Software, User, Group, " +
      "Entity, Location, ITILCategory, Supplier, Contract, Document, KnowbaseItem",
  );
const fieldsObj = z.record(z.string(), z.unknown());

const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp)$/i;
const TEXT_MIME = /^(text\/|application\/(json|xml|x-yaml|yaml|csv))/i;

function today(offsetDays = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

export function registerTools(server: McpServer, source: BackendSource, config: Config): string[] {
  const names: string[] = [];
  const limitSchema = z.number().int().min(1).max(config.maxLimit).default(Math.min(20, config.maxLimit));
  const startSchema = z.number().int().min(0).default(0).describe("Offset for pagination");

  const run =
    <A>(fn: (b: GlpiBackend, args: A) => Promise<unknown>) =>
    async (args: A): Promise<ToolResult> => {
      try {
        const result = await source.run((b) => fn(b, args));
        return isToolResult(result) ? result : ok(result);
      } catch (err) {
        return fail(err);
      }
    };

  const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

  const add = (
    name: string,
    title: string,
    description: string,
    inputSchema: z.ZodRawShape,
    annotations: Record<string, boolean>,
    handler: (args: any) => Promise<ToolResult>,
  ) => {
    server.registerTool(name, { title, description, inputSchema, annotations: { title, ...annotations } }, handler);
    names.push(name);
  };

  // =============================================================== read tools

  add(
    "glpi_server_info",
    "GLPI server info",
    "Show which GLPI API this server uses (legacy REST or High-Level API and its pinned version), the GLPI URL, " +
      "whose identity the tools act with and the safety modes. Call it first when a connection problem is suspected.",
    {},
    read,
    run(async (b) => ({
      ...(await b.describe()),
      glpi_url: config.glpiUrl,
      identity: source.identity === "user" ? "the connected user's own GLPI account" : "the configured service account",
      read_only: config.readOnly,
      delete_allowed: !config.readOnly && config.allowDelete,
      max_limit: config.maxLimit,
      max_file_mb: Math.round(config.maxFileBytes / 1024 / 1024),
    })),
  );

  add(
    "glpi_whoami",
    "Current GLPI user",
    "The GLPI user the tools act as, with the active profile, entity and group IDs. Every call runs with that user's rights.",
    {},
    read,
    run((b) => b.whoami()),
  );

  add(
    "glpi_my_tickets",
    "My queue",
    "Open tickets (or changes/problems) assigned to the current user and, by default, to the user's groups, " +
      "highest priority first. The natural first call for 'what should I work on?'.",
    {
      itil_type: itilType,
      include_groups: z.boolean().default(true).describe("Also include items assigned to my groups"),
      statuses: z.array(z.number().int().min(1).max(6)).optional().describe("Status IDs; default: all open statuses"),
      start: startSchema,
      limit: limitSchema,
    },
    read,
    run((b, a: any) =>
      b.myQueue({ itilType: a.itil_type, includeGroups: a.include_groups, statuses: a.statuses, start: a.start, limit: a.limit }),
    ),
  );

  add(
    "glpi_sla_at_risk",
    "Tickets at SLA risk",
    "Open tickets whose time-to-resolve (and/or time-to-own) target is already exceeded or falls within the next " +
      "N hours, soonest first. Optional internal targets (OLA). Dates are in GLPI server time.",
    {
      within_hours: z.number().int().min(1).max(720).default(4).describe("Look-ahead window for 'due soon'"),
      targets: z.array(z.enum(["resolve", "own"])).min(1).default(["resolve", "own"]),
      include_ola: z.boolean().default(false).describe("Also check internal targets (OLA)"),
      assigned_group: ref("Assigned group").optional(),
      assigned_user: ref("Assigned technician").optional(),
      limit: limitSchema,
    },
    read,
    run(async (b, a: any) => {
      const r = await resolveAll(b, { group: ["Group", a.assigned_group], user: ["User", a.assigned_user] });
      return b.slaAtRisk({
        kinds: a.targets,
        withinHours: a.within_hours,
        includeOla: a.include_ola,
        assignedGroupId: r.group,
        assignedUserId: r.user,
        limit: a.limit,
      });
    }),
  );

  add(
    "glpi_search_tickets",
    "Search tickets, changes or problems",
    "List tickets (or changes/problems), most recently updated first, with a compact summary of each. " +
      "Status IDs: 1 new, 2 processing (assigned), 3 processing (planned), 4 pending, 5 solved, 6 closed. " +
      "Priority IDs: 1 very low ... 5 very high, 6 major. Ticket type: 1 incident, 2 request. " +
      "People, groups and categories can be given by name. Use glpi_get_ticket for one item's full detail.",
    {
      itil_type: itilType,
      text: z.string().min(1).optional().describe("Text to look for in the title or description"),
      statuses: z.array(z.number().int().min(1).max(6)).optional().describe("Status IDs to include"),
      open_only: z.boolean().default(true).describe("Exclude solved and closed items (ignored when statuses is set)"),
      priorities: z.array(z.number().int().min(1).max(6)).optional(),
      ticket_type: z.number().int().min(1).max(2).optional().describe("1 incident, 2 request (tickets only)"),
      category: ref("ITIL category").optional(),
      assigned_user: ref("Assigned technician").optional(),
      assigned_group: ref("Assigned group").optional(),
      requester: ref("Requester").optional(),
      start: startSchema,
      limit: limitSchema,
    },
    read,
    run(async (b, a: any) => {
      const r = await resolveAll(b, {
        category: ["ITILCategory", a.category],
        user: ["User", a.assigned_user],
        group: ["Group", a.assigned_group],
        requester: ["User", a.requester],
      });
      return b.listItil({
        itilType: a.itil_type as ItilType,
        text: a.text,
        statuses: a.statuses,
        openOnly: a.open_only,
        priorities: a.priorities,
        ticketType: a.ticket_type,
        categoryId: r.category,
        assignedUserId: r.user,
        assignedGroupId: r.group,
        requesterUserId: r.requester,
        start: a.start,
        limit: a.limit,
      });
    }),
  );

  add(
    "glpi_get_ticket",
    "Get a ticket, change or problem",
    "Full details of one ticket (or change/problem) as readable text: description, timeline (followups, tasks, " +
      "solutions), team (requesters, technicians, groups, observers) and linked assets.",
    {
      id,
      itil_type: itilType,
      include_timeline: z.boolean().default(true),
      include_team: z.boolean().default(true),
    },
    read,
    run(async (b, a: any) => {
      const [item, timeline, team] = await Promise.all([
        b.getItil(a.itil_type, a.id),
        a.include_timeline ? b.getItilTimeline(a.itil_type, a.id) : Promise.resolve(undefined),
        a.include_team ? b.getItilTeam(a.itil_type, a.id) : Promise.resolve(undefined),
      ]);
      return { item, timeline, team };
    }),
  );

  add(
    "glpi_find_similar",
    "Find similar tickets and KB articles",
    "Given a problem description, find knowledge base articles, open tickets (possible duplicates) and solved " +
      "tickets (with how they were solved) that match it. Use it before creating a ticket and when triaging.",
    {
      text: z.string().min(3).max(4000).describe("The problem as the user described it"),
      include_kb: z.boolean().default(true),
      include_open: z.boolean().default(true).describe("Open tickets: possible duplicates"),
      include_solved: z.boolean().default(true).describe("Solved tickets, with their solution"),
      limit: z.number().int().min(1).max(30).default(10),
    },
    read,
    run((b, a: any) =>
      b.findSimilar({
        text: a.text,
        includeKb: a.include_kb,
        includeOpen: a.include_open,
        includeSolved: a.include_solved,
        limit: a.limit,
      }),
    ),
  );

  add(
    "glpi_search_items",
    "Search GLPI items by name",
    "Find assets, users (by login, first or last name), groups, locations, categories, suppliers, KB articles or any " +
      "other itemtype by name (partial match). Returns IDs for the other tools.",
    { itemtype, query: z.string().min(1), start: startSchema, limit: limitSchema },
    read,
    run((b, a: any) => b.searchItems(a.itemtype, a.query, a.start, a.limit)),
  );

  add(
    "glpi_list_items",
    "List GLPI items",
    "List items of one itemtype (e.g. all Computers), paginated.",
    { itemtype, start: startSchema, limit: limitSchema },
    read,
    run((b, a: any) => b.listItems(a.itemtype, a.start, a.limit)),
  );

  add(
    "glpi_get_item",
    "Get a GLPI item",
    "Full record of one item of any itemtype (asset, user, group, KB article...). Rich text comes back as plain text.",
    { itemtype, id },
    read,
    run((b, a: any) => b.getItem(a.itemtype, a.id)),
  );

  add(
    "glpi_asset_context",
    "Asset context and ticket history",
    "One asset (Computer, Monitor, Phone, Printer, NetworkEquipment...) with its owner, location, status and its " +
      "ticket history (open and recent tickets). Asset can be given by ID or by name/serial.",
    {
      itemtype: itemtype.default("Computer"),
      asset: ref("Asset"),
      ticket_limit: z.number().int().min(1).max(50).default(10),
    },
    read,
    run(async (b, a: any) => {
      const assetId = await resolveRef(b, a.itemtype, a.asset);
      return b.assetContext(a.itemtype, assetId!, a.ticket_limit);
    }),
  );

  add(
    "glpi_search_knowledgebase",
    "Search the knowledge base",
    "Find knowledge base articles whose title matches the text. For a problem description, glpi_find_similar is " +
      "usually better. Read one article with glpi_get_item (itemtype KnowbaseItem).",
    { query: z.string().min(1), start: startSchema, limit: limitSchema },
    read,
    run((b, a: any) => b.searchItems("KnowbaseItem", a.query, a.start, a.limit)),
  );

  add(
    "glpi_list_attachments",
    "List attachments",
    "Documents attached to a ticket, change, problem or any other item (screenshots, logs, files).",
    { itemtype: itemtype.default("Ticket"), id },
    read,
    run((b, a: any) => b.listDocuments(a.itemtype, a.id)),
  );

  add(
    "glpi_get_attachment",
    "Read an attachment",
    "Download one document by its document ID (from glpi_list_attachments). Images are returned as images so they " +
      "can be looked at, text files as text, other files as an embedded resource.",
    { document_id: id },
    read,
    run(async (b, a: any) => {
      const doc = await b.downloadDocument(a.document_id, config.maxFileBytes);
      const header = { type: "text" as const, text: `Document ${doc.id}: ${doc.filename} (${doc.mime}, ${doc.bytes.length} bytes)` };
      if (IMAGE_MIME.test(doc.mime)) {
        return { content: [header, { type: "image", data: doc.bytes.toString("base64"), mimeType: doc.mime }] } as ToolResult;
      }
      if (TEXT_MIME.test(doc.mime) || /\.(txt|log|csv|json|xml|ya?ml|md|ini|conf)$/i.test(doc.filename)) {
        const text = doc.bytes.toString("utf8");
        return ok(`${header.text}\n\n${text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n... [truncated]` : text}`);
      }
      return {
        content: [
          header,
          {
            type: "resource",
            resource: { uri: `glpi://document/${doc.id}/${encodeURIComponent(doc.filename)}`, mimeType: doc.mime, blob: doc.bytes.toString("base64") },
          },
        ],
      } as ToolResult;
    }),
  );

  add(
    "glpi_pending_approvals",
    "My pending approvals",
    "Tickets (or changes) waiting for the current user's approval, oldest request first.",
    { itil_type: z.enum(["Ticket", "Change"]).default("Ticket"), limit: limitSchema },
    read,
    run((b, a: any) => b.listPendingValidations(a.itil_type, a.limit)),
  );

  add(
    "glpi_list_approvals",
    "Approvals of a ticket",
    "All approval requests of one ticket or change, with their status and comments.",
    { id, itil_type: z.enum(["Ticket", "Change"]).default("Ticket") },
    read,
    run((b, a: any) => b.listValidations(a.itil_type, a.id)),
  );

  add(
    "glpi_ticket_stats",
    "Service desk metrics",
    "Metrics for items opened in a date range: volume by status, priority, type, category and group; resolution " +
      "time and time to own (mean, median, p90); time-to-resolve SLA compliance. Defaults to the last 30 days.",
    {
      itil_type: itilType,
      from: date.optional().describe("First day, YYYY-MM-DD (default: 30 days ago)"),
      to: date.optional().describe("Last day, YYYY-MM-DD (default: today)"),
      assigned_group: ref("Assigned group").optional(),
      category: ref("ITIL category").optional(),
      max_rows: z.number().int().min(50).max(10000).default(2000).describe("Safety cap on items analyzed"),
    },
    read,
    run(async (b, a: any) => {
      const from = a.from ?? today(-30);
      const to = a.to ?? today();
      if (from > to) throw new Error("'from' must be on or before 'to'");
      const r = await resolveAll(b, { group: ["Group", a.assigned_group], category: ["ITILCategory", a.category] });
      return b.itilStats({
        itilType: a.itil_type,
        from,
        to,
        assignedGroupId: r.group,
        categoryId: r.category,
        maxRows: a.max_rows,
      });
    }),
  );

  add(
    "glpi_raw_get",
    "Raw GET on the GLPI API",
    "Read-only escape hatch: GET any endpoint of the API in use, relative to its root. " +
      "Legacy examples: 'Ticket/12/Document_Item', 'search/Computer' with query {criteria: [...]}, 'listSearchOptions/Ticket'. " +
      "High-Level examples: 'Assets/Computer/5', 'Administration/User/Me'. Call glpi_server_info to know which API is active.",
    {
      path: z.string().min(1).max(300),
      query: fieldsObj.optional().describe("Query parameters; nested objects/arrays are encoded PHP-style"),
    },
    read,
    run((b, a: any) => b.rawGet(a.path, a.query)),
  );

  if (config.readOnly) return names;

  // ============================================================== write tools

  add(
    "glpi_create_ticket",
    "Create a ticket, change or problem",
    "Create a ticket (or change/problem). Run glpi_find_similar first to avoid duplicates and offer known fixes. " +
      "Priority is computed by GLPI from urgency and impact when omitted. People, groups, categories and locations " +
      "can be given by name. Confirm the content with the user before creating.",
    {
      itil_type: itilType,
      name: z.string().min(1).max(255).describe("Title"),
      content: z.string().min(1).describe("Description (HTML or plain text)"),
      ticket_type: z.number().int().min(1).max(2).optional().describe("1 incident, 2 request (tickets only)"),
      urgency: level.optional(),
      impact: level.optional(),
      priority: z.number().int().min(1).max(6).optional(),
      category: ref("ITIL category").optional(),
      entity_id: z.number().int().min(0).optional(),
      location: ref("Location").optional(),
      requester: ref("Requester").optional(),
      assigned_user: ref("Assigned technician").optional(),
      assigned_group: ref("Assigned group").optional(),
    },
    write,
    run(async (b, a: any) => {
      const r = await resolveAll(b, {
        category: ["ITILCategory", a.category],
        location: ["Location", a.location],
        requester: ["User", a.requester],
        user: ["User", a.assigned_user],
        group: ["Group", a.assigned_group],
      });
      return b.createItil({
        itilType: a.itil_type,
        name: a.name,
        content: a.content,
        ticketType: a.ticket_type,
        urgency: a.urgency,
        impact: a.impact,
        priority: a.priority,
        categoryId: r.category,
        entityId: a.entity_id,
        locationId: r.location,
        requesterUserId: r.requester,
        assignedUserId: r.user,
        assignedGroupId: r.group,
      });
    }),
  );

  add(
    "glpi_update_ticket",
    "Update a ticket, change or problem",
    "Change fields of a ticket (status, priority, urgency, impact, category, location, title, description...). " +
      "Use 'extra' for other fields, in the active API's own field names.",
    {
      id,
      itil_type: itilType,
      name: z.string().min(1).max(255).optional(),
      content: z.string().min(1).optional(),
      status: z.number().int().min(1).max(6).optional(),
      urgency: level.optional(),
      impact: level.optional(),
      priority: z.number().int().min(1).max(6).optional(),
      ticket_type: z.number().int().min(1).max(2).optional(),
      category: ref("ITIL category").optional(),
      location: ref("Location").optional(),
      extra: fieldsObj.optional(),
    },
    { ...write, idempotentHint: true },
    run(async (b, a: any) => {
      const r = await resolveAll(b, { category: ["ITILCategory", a.category], location: ["Location", a.location] });
      return b.updateItil(a.itil_type, a.id, {
        name: a.name,
        content: a.content,
        status: a.status,
        urgency: a.urgency,
        impact: a.impact,
        priority: a.priority,
        ticketType: a.ticket_type,
        categoryId: r.category,
        locationId: r.location,
        extra: a.extra,
      });
    }),
  );

  add(
    "glpi_add_followup",
    "Add a followup",
    "Add a followup (a reply/comment in the conversation) to a ticket, change or problem. " +
      "Public followups are visible to the requester and may trigger email notifications.",
    { id, itil_type: itilType, content: z.string().min(1), is_private: z.boolean().default(false) },
    write,
    run((b, a: any) => b.addFollowup(a.itil_type, a.id, a.content, a.is_private)),
  );

  add(
    "glpi_add_task",
    "Add a task",
    "Add a task (work to do or done, with time spent) to a ticket, change or problem.",
    {
      id,
      itil_type: itilType,
      content: z.string().min(1),
      is_private: z.boolean().default(true),
      state: z.number().int().min(0).max(2).optional().describe("0 information, 1 to do, 2 done"),
      duration_seconds: z.number().int().min(0).optional().describe("Time spent, in seconds"),
      technician: ref("Technician in charge of the task").optional(),
    },
    write,
    run(async (b, a: any) =>
      b.addTask(a.itil_type, a.id, {
        content: a.content,
        isPrivate: a.is_private,
        state: a.state,
        durationSeconds: a.duration_seconds,
        techUserId: await resolveRef(b, "User", a.technician),
      }),
    ),
  );

  add(
    "glpi_add_solution",
    "Add a solution",
    "Add a solution to a ticket, change or problem, which marks it solved (the requester may approve or refuse it).",
    { id, itil_type: itilType, content: z.string().min(1) },
    write,
    run((b, a: any) => b.addSolution(a.itil_type, a.id, a.content)),
  );

  add(
    "glpi_assign",
    "Assign or add a team member",
    "Add a user or group to a ticket, change or problem as requester, assigned technician/group, or observer. " +
      "The member can be given by name ('Mario', 'Service Desk') or ID; 'me' means the current user.",
    {
      id,
      itil_type: itilType,
      member_type: z.enum(["User", "Group"]),
      member: ref("User or group"),
      role: z.enum(["requester", "assigned", "observer"]).default("assigned"),
    },
    write,
    run(async (b, a: any) => {
      const memberId = await resolveRef(b, a.member_type, a.member as Ref);
      return b.addTeamMember(a.itil_type, a.id, a.member_type, memberId!, a.role);
    }),
  );

  add(
    "glpi_upload_attachment",
    "Attach a file",
    "Attach a file to a ticket, change, problem or any other item. Give the content either as text or base64.",
    {
      itemtype: itemtype.default("Ticket"),
      id,
      filename: z.string().min(1).max(200).regex(/^[^\\/\0]+$/, "A file name, not a path"),
      text: z.string().optional().describe("File content as text (e.g. a log excerpt or a note)"),
      content_base64: z.string().optional().describe("File content as base64 (binary files)"),
      mime_type: z.string().max(100).optional().describe("Default: guessed from the file extension"),
    },
    write,
    run(async (b, a: any) => {
      if ((a.text === undefined) === (a.content_base64 === undefined)) throw new Error("Give exactly one of text or content_base64");
      const bytes = a.text !== undefined ? Buffer.from(a.text, "utf8") : Buffer.from(a.content_base64, "base64");
      if (!bytes.length) throw new Error("The file is empty");
      if (bytes.length > config.maxFileBytes) throw new Error(`The file is over the ${config.maxFileBytes} byte limit`);
      return b.uploadDocument(a.itemtype, a.id, a.filename, a.mime_type ?? guessMime(a.filename), bytes);
    }),
  );

  add(
    "glpi_request_approval",
    "Request an approval",
    "Ask a user to approve a ticket or change. The validator can be given by name or ID.",
    {
      id,
      itil_type: z.enum(["Ticket", "Change"]).default("Ticket"),
      validator: ref("Validator (user)"),
      comment: z.string().max(5000).optional(),
    },
    write,
    run(async (b, a: any) => {
      const validator = await resolveRef(b, "User", a.validator);
      return b.requestValidation(a.itil_type, a.id, validator!, a.comment);
    }),
  );

  add(
    "glpi_answer_approval",
    "Approve or refuse",
    "Approve or refuse an approval request addressed to the current user (validation_id from " +
      "glpi_pending_approvals). Refusing requires a reason. Confirm the decision with the user first.",
    {
      validation_id: id,
      itil_type: z.enum(["Ticket", "Change"]).default("Ticket"),
      decision: z.enum(["approve", "refuse"]),
      comment: z.string().max(5000).optional(),
    },
    write,
    run((b, a: any) => b.answerValidation(a.itil_type, a.validation_id, a.decision, a.comment)),
  );

  add(
    "glpi_create_item",
    "Create a GLPI item",
    "Create an item of any itemtype (asset, location, KB article...). Fields use the active API's field names; " +
      "check an existing item with glpi_get_item to see them.",
    { itemtype, fields: fieldsObj },
    write,
    run((b, a: any) => b.createItem(a.itemtype, a.fields)),
  );

  add(
    "glpi_update_item",
    "Update a GLPI item",
    "Change fields of an item of any itemtype. Fields use the active API's field names.",
    { itemtype, id, fields: fieldsObj },
    { ...write, idempotentHint: true },
    run((b, a: any) => b.updateItem(a.itemtype, a.id, a.fields)),
  );

  if (!config.allowDelete) return names;

  add(
    "glpi_delete_item",
    "Delete a GLPI item",
    "Move an item to the trash, or purge it permanently with purge=true. Always confirm with the user first.",
    { itemtype, id, purge: z.boolean().default(false).describe("Delete permanently instead of moving to the trash") },
    { ...write, destructiveHint: true, idempotentHint: true },
    run((b, a: any) => b.deleteItem(a.itemtype, a.id, a.purge)),
  );

  return names;
}

function isToolResult(value: unknown): value is ToolResult {
  return Boolean(value && typeof value === "object" && Array.isArray((value as ToolResult).content));
}

const MIME_BY_EXT: Record<string, string> = {
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function guessMime(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}
