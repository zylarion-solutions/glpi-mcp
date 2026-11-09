/**
 * MCP prompts: ready-made service desk workflows that clients show as slash
 * commands (e.g. /glpi:triage in Claude). They only guide the assistant; every
 * change still goes through the tools and needs the user's confirmation.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "./config.js";

const CONFIRM = "Do not create or change anything in GLPI until the user confirms the exact change.";

function message(text: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}

const optionalText = (description: string) => z.string().max(500).optional().describe(description);

export function registerPrompts(server: McpServer, config: Config): string[] {
  const names: string[] = [];
  const writeNote = config.readOnly
    ? "This server is read-only: propose changes as a list the user can apply in GLPI."
    : CONFIRM;

  server.registerPrompt(
    "triage",
    {
      title: "Triage new tickets",
      description: "Review new, unassigned tickets and propose category, priority and assignment for each.",
      argsSchema: {
        group: optionalText("Only tickets of this group (name or ID)"),
        limit: optionalText("How many tickets to review (default 10)"),
      },
    },
    ({ group, limit }) =>
      message(
        [
          `Triage the newest GLPI tickets${group ? ` of the group "${group}"` : ""}.`,
          `1. Call glpi_search_tickets with statuses [1] (new)${group ? ` and assigned_group "${group}"` : ""}, limit ${limit || "10"}.`,
          "2. For each ticket, read it with glpi_get_ticket (include_timeline false) and call glpi_find_similar with its title and description.",
          "3. Propose for each: category, urgency/impact (and the resulting priority), the best group or technician, " +
            "duplicates to link or merge, and a KB article or past solution that may already answer it.",
          "4. Present a compact table (ticket, proposal, reason), then the details only where something needs attention.",
          writeNote,
        ].join("\n"),
      ),
  );
  names.push("triage");

  server.registerPrompt(
    "daily_summary",
    {
      title: "Daily summary",
      description: "My queue, SLA risks and yesterday's numbers in one short briefing.",
      argsSchema: { group: optionalText("Focus on this group (name or ID)") },
    },
    ({ group }) =>
      message(
        [
          `Give me a short daily service desk briefing${group ? ` for the group "${group}"` : ""}.`,
          "1. glpi_my_tickets: what is assigned to me and my groups, highest priority first.",
          `2. glpi_sla_at_risk with within_hours 8${group ? ` and assigned_group "${group}"` : ""}: what is overdue or due today.`,
          `3. glpi_ticket_stats for yesterday${group ? ` and assigned_group "${group}"` : ""}: opened, solved, resolution time, SLA compliance.`,
          "Answer in at most 15 lines: first what needs action now, then the numbers. Use ticket IDs.",
        ].join("\n"),
      ),
  );
  names.push("daily_summary");

  server.registerPrompt(
    "shift_handover",
    {
      title: "Shift handover",
      description: "Hand over the open work of a person or group to the next shift.",
      argsSchema: {
        group: optionalText("Group handing over (name or ID); default: my queue"),
        hours: optionalText("SLA look-ahead in hours (default 12)"),
      },
    },
    ({ group, hours }) =>
      message(
        [
          `Prepare a shift handover${group ? ` for the group "${group}"` : " for my queue"}.`,
          group
            ? `1. glpi_search_tickets with assigned_group "${group}" (open items, most recently updated first).`
            : "1. glpi_my_tickets.",
          `2. glpi_sla_at_risk with within_hours ${hours || "12"}${group ? ` and assigned_group "${group}"` : ""}.`,
          "3. For the items that are pending, high priority or at SLA risk, read the latest timeline entries with glpi_get_ticket.",
          "Write the handover as: urgent (SLA), in progress (state and next step), waiting on others (on whom), and notes. " +
            "One line per ticket with its ID.",
        ].join("\n"),
      ),
  );
  names.push("shift_handover");

  server.registerPrompt(
    "new_incident",
    {
      title: "Report a new incident",
      description: "Turn a problem description into a well-formed ticket, checking known fixes and duplicates first.",
      argsSchema: { description: z.string().min(3).max(4000).describe("What is happening, in the user's words") },
    },
    ({ description }) =>
      message(
        [
          "A user reports this problem:",
          `"""${description}"""`,
          "1. Call glpi_find_similar with that text.",
          "2. If a KB article or past solution clearly applies, offer it first and ask whether it fixes the problem.",
          "3. If an open ticket already covers it, say so and offer to add a followup there instead of a new ticket.",
          "4. Otherwise draft the ticket: clear title, description with the facts given (what, since when, who is " +
            "affected, error messages), type (incident or request), urgency and impact, and the likely category " +
            "(look it up with glpi_search_items, itemtype ITILCategory). Ask only for missing facts that matter.",
          config.readOnly
            ? "This server is read-only: give the user the draft to submit in GLPI."
            : "5. Show the draft and create it with glpi_create_ticket only after the user confirms.",
        ].join("\n"),
      ),
  );
  names.push("new_incident");

  server.registerPrompt(
    "review_approvals",
    {
      title: "Review my approvals",
      description: "Go through the tickets waiting for my approval with the context needed to decide.",
      argsSchema: {},
    },
    () =>
      message(
        [
          "List what is waiting for my approval with glpi_pending_approvals (tickets, then changes with itil_type Change).",
          "For each, read the item with glpi_get_ticket and summarize in two lines what is requested, by whom, and any cost or risk mentioned.",
          config.readOnly
            ? "This server is read-only: I will decide in GLPI."
            : "Then ask me for each decision. Use glpi_answer_approval only after I decide; a refusal needs my reason.",
        ].join("\n"),
      ),
  );
  names.push("review_approvals");

  return names;
}
