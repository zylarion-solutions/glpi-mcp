# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-11-09

### Added
- **Names instead of IDs**: users, groups, categories, locations and assets can be given by name in every tool;
  ambiguous names return the candidates so the assistant can ask.
- **Readable text**: GLPI rich text (including entity-encoded "sanitized" content) is returned as compact plain text.
- `glpi_my_tickets`: open items assigned to the current user and their groups, by priority.
- `glpi_sla_at_risk`: items past or near their time-to-own / time-to-resolve targets, with optional OLA.
- `glpi_find_similar`: KB articles, open duplicates and solved tickets (with their solution) for a problem description.
- Attachments: `glpi_list_attachments`, `glpi_get_attachment` (images returned as images), `glpi_upload_attachment`.
- Approvals: `glpi_pending_approvals`, `glpi_list_approvals`, `glpi_request_approval`, `glpi_answer_approval`.
- `glpi_asset_context`: an asset with owner, location, status and ticket history; linked assets in `glpi_get_ticket`.
- `glpi_ticket_stats`: volume, resolution time, time to own and SLA compliance for a date range.
- MCP prompts: `triage`, `daily_summary`, `shift_handover`, `new_incident`, `review_approvals`.
- **Per-user identity** over HTTP: `MCP_ALLOW_USER_TOKENS` (token mode) and `MCP_AUTH_MODE=oauth`, an OAuth 2.1
  authorization server (dynamic client registration, PKCE, rotating refresh tokens, encrypted state) so the server
  works as a claude.ai custom connector and each person acts with their own GLPI rights. Hardened with an
  allow-list of redirect hosts (`MCP_OAUTH_REDIRECT_HOSTS`), RFC 8252 loopback redirects, refresh token reuse
  detection, a maximum sign-in age (`MCP_OAUTH_MAX_GRANT_DAYS`), per-user connection limits and expiry of
  unused clients.
- Automatic fallback to the legacy API for features the High-Level API does not cover yet.

### Changed
- Text search in `glpi_search_tickets` matches the title or the description (legacy API).
- `glpi_search_items` finds users by login, first name or last name.
- Requires Node.js 22+.

### Fixed
- Knowledge base search on the legacy API used the wrong search option (name is option 6, not 1).
- Request timeouts now also cover reading the response body.

## [0.1.0] - 2026-11-04

### Added
- First release: legacy REST API and GLPI 11+ High-Level API backends with auto-detection, ticket/change/problem
  tools, generic item tools, knowledge base search, read-only by default, stdio and Streamable HTTP transports.
