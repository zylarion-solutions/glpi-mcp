import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import type { BackendSource } from "./glpi/factory.js";
import { registerPrompts } from "./prompts.js";
import { registerTools } from "./tools.js";
import { VERSION } from "./version.js";

const INSTRUCTIONS = `Tools for a GLPI IT service management instance.
- Every call acts with the rights of one GLPI user (see glpi_whoami).
- People, groups, categories, locations and assets can be given by name; when a name is ambiguous the tool returns the candidates: ask the user which one.
- "What should I work on?" -> glpi_my_tickets, then glpi_sla_at_risk.
- Before creating a ticket, run glpi_find_similar: offer known fixes and avoid duplicates.
- Ticket text comes back as plain text; screenshots can be read with glpi_list_attachments and glpi_get_attachment.
- Before creating or changing anything, confirm the exact content with the user.
- Public followups and solutions are visible to the requester and can send emails.`;

export function createServer(config: Config, source: BackendSource): McpServer {
  const server = new McpServer({ name: "glpi-mcp", version: VERSION }, { instructions: INSTRUCTIONS });
  registerTools(server, source, config);
  registerPrompts(server, config);
  return server;
}
