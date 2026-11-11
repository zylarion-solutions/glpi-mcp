# glpi-mcp

MCP (Model Context Protocol) server that lets Claude and other AI assistants work with **GLPI** the way a
service desk actually works: *"what's in my queue?"*, *"what's about to breach SLA?"*, *"has this happened
before?"*, *"assign it to Mario"*, *"what's in this screenshot?"*, *"approve the laptop request"*.

- **Works with GLPI 9.5, 10, 11 and 12.** It speaks both GLPI APIs and picks one automatically.
- **Plain language in, plain text out.** People, groups, categories, locations and assets can be given by
  name; ticket text comes back as readable text, not HTML.
- **Each person can act as themselves.** Run it for one service account, or let every user sign in with
  their own GLPI token (including as a **claude.ai custom connector** over OAuth).
- **Safe by default.** Read-only unless you enable writes; deleting needs a second switch.

Runs over **stdio** (Claude Desktop, Claude Code) or **Streamable HTTP** (a remote server for claude.ai,
Claude Code, the Claude API MCP connector or your own agents).

---

## What you can ask

| You say | The assistant uses |
|---|---|
| "What should I work on?" | `glpi_my_tickets`, `glpi_sla_at_risk` |
| "Anything about to breach SLA for Service Desk?" | `glpi_sla_at_risk` (time to own / resolve, optional OLA) |
| "Users say Outlook keeps asking for the password" | `glpi_find_similar` → KB articles, possible duplicates, how it was solved before |
| "Open a ticket for that and assign it to Mario" | `glpi_create_ticket` with names resolved to IDs |
| "What's in the screenshot of ticket 4512?" | `glpi_list_attachments`, `glpi_get_attachment` (images come back as images) |
| "Approve the laptop request" | `glpi_pending_approvals`, `glpi_answer_approval` |
| "Tell me about LAPTOP-07" | `glpi_asset_context` (owner, location, status, ticket history) |
| "How did we do last month?" | `glpi_ticket_stats` (volume, resolution time, time to own, SLA compliance) |

### Prompts (slash commands)

Clients that support MCP prompts show these as commands (in Claude: type `/` and look for *glpi*):

| Prompt | What it does |
|---|---|
| `triage` | Reviews new tickets and proposes category, priority, assignee, duplicates and known fixes |
| `daily_summary` | My queue, SLA risks and yesterday's numbers in a short briefing |
| `shift_handover` | Hands over a person's or group's open work, SLA risks first |
| `new_incident` | Turns a problem description into a ticket, offering KB fixes and duplicates first |
| `review_approvals` | Walks through the approvals waiting for me with the context to decide |

## Tools

**Read** (always available)

| Tool | What it does |
|------|--------------|
| `glpi_server_info` | Active API and version, identity mode, safety modes |
| `glpi_whoami` | GLPI user, profile, entity and groups the tools act as |
| `glpi_my_tickets` | Open items assigned to me and my groups, highest priority first |
| `glpi_sla_at_risk` | Items past or near their time-to-own / time-to-resolve target (and OLA) |
| `glpi_search_tickets` | Search tickets / changes / problems by status, priority, type, category, text, assignee, requester |
| `glpi_get_ticket` | One item as text: description, timeline (followups, tasks, solutions), team, linked assets |
| `glpi_find_similar` | KB articles, open duplicates and solved tickets (with their solution) matching a description |
| `glpi_search_items` | Find any itemtype by name (users by login, first or last name) |
| `glpi_list_items` / `glpi_get_item` | List or read items of any itemtype |
| `glpi_asset_context` | An asset with its owner, location, status and ticket history |
| `glpi_search_knowledgebase` | Search KB articles by title |
| `glpi_list_attachments` / `glpi_get_attachment` | Documents of an item; download one (images as images, text as text) |
| `glpi_pending_approvals` / `glpi_list_approvals` | Approvals waiting for me; approvals of one item |
| `glpi_ticket_stats` | Metrics for a date range: volume, resolution time, time to own, SLA compliance |
| `glpi_raw_get` | Read-only GET on any endpoint of the active API |

**Write** (only with `GLPI_READ_ONLY=false`)

`glpi_create_ticket`, `glpi_update_ticket`, `glpi_add_followup`, `glpi_add_task`, `glpi_add_solution`,
`glpi_assign` (requester / assigned / observer, user or group), `glpi_upload_attachment`,
`glpi_request_approval`, `glpi_answer_approval`, `glpi_create_item`, `glpi_update_item`.

**Delete** (only with `GLPI_READ_ONLY=false` **and** `GLPI_ALLOW_DELETE=true`): `glpi_delete_item`.

Tools carry MCP annotations (`readOnlyHint`, `destructiveHint`) so clients ask before writing.

### Names instead of IDs

Wherever a tool expects a user, group, category, location or asset you can pass a name:
`assigned_group: "Service Desk"`, `category: "Laptops"`, `member: "Mario"`, `requester: "me"`.
A unique match is used. If a name is ambiguous, the tool returns the candidates with their IDs and the
assistant asks which one you mean.

### Which API, which features

| GLPI | API used | Auth |
|------|----------|------|
| 9.5 / 10.x | Legacy REST API (`/apirest.php`) | App-Token (optional) + user token, or login/password |
| 11.x / 12.x | High-Level API (`/api.php`, version pinned) **or** legacy REST API | OAuth2 password grant, or user token |

Everything works on the legacy API. On the High-Level API, my queue, SLA dates, attachments, approvals,
asset history and statistics are not available yet. GLPI 11 and 12 still ship the legacy API, so when legacy
credentials are configured as well (a user token, or the same username/password), those tools
**automatically fall back to the legacy API**.

---

## 1. Prepare GLPI

**Enable the API** (any version): *Setup > General > API*: enable the REST API and
"Enable login with external token". Optionally add an API client with an **App-Token** and restrict it by IP.

Then choose how the tools act in GLPI:

- **One service account** (simplest): create a user such as `svc-mcp` with a least-privilege profile on the
  entities it should see. Log in as it > *My settings* > *Remote access keys* > regenerate the **API token**.
- **Each person as themselves** (HTTP mode, see below): every user uses their own API token from
  *My settings > Remote access keys*. GLPI applies each person's own profile and entities.

**High-Level API** (GLPI 11+, optional): *Setup > OAuth clients* > Add: grant **Password**, scope **api**.

## 2. Install

Requires Node.js 22+.

```sh
git clone https://github.com/zylarion-solutions/glpi-mcp.git
cd glpi-mcp
npm ci        # also builds dist/
cp .env.example .env   # reference for the variables
```

## 3. Connect it

### Claude Code (stdio)

```sh
claude mcp add glpi \
  -e GLPI_URL=https://glpi.example.com \
  -e GLPI_USER_TOKEN=xxxx \
  -e GLPI_APP_TOKEN=yyyy \
  -- node /absolute/path/to/glpi-mcp/dist/index.js
```

### Claude Desktop (stdio)

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "glpi": {
      "command": "node",
      "args": ["/absolute/path/to/glpi-mcp/dist/index.js"],
      "env": {
        "GLPI_URL": "https://glpi.example.com",
        "GLPI_APP_TOKEN": "...",
        "GLPI_USER_TOKEN": "...",
        "GLPI_READ_ONLY": "true"
      }
    }
  }
}
```

### Remote server (Streamable HTTP)

```sh
docker build -t glpi-mcp .
docker run -d --name glpi-mcp -p 8000:8000 --env-file .env glpi-mcp
```

Put it behind HTTPS (reverse proxy, tunnel, PaaS). `GET /healthz` is an unauthenticated health check.
Behind a reverse proxy set `MCP_TRUST_PROXY=1` so rate limiting sees the real client address.

#### Option A — static token (Claude Code, Claude API, agents)

```sh
# .env: MCP_TRANSPORT=http, MCP_AUTH_TOKEN=$(openssl rand -hex 32)
claude mcp add --transport http glpi https://mcp.example.com/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

Tools act as the service account. To let each client act as its own GLPI user, set
`MCP_ALLOW_USER_TOKENS=true`; clients then add `X-GLPI-User-Token: <their GLPI API token>`.

#### Option B — OAuth (claude.ai custom connectors, everyone as themselves)

> Step-by-step for the most common setup, glpi-mcp on the same server as GLPI behind its existing
> Apache or Nginx: **[docs/deploy.md](docs/deploy.md)** (ready-made files in [`deploy/`](deploy/)).

```sh
MCP_TRANSPORT=http
MCP_AUTH_MODE=oauth
MCP_PUBLIC_URL=https://mcp.example.com          # the URL users will add
MCP_OAUTH_SECRET=$(openssl rand -hex 32)        # keep it secret and stable
MCP_OAUTH_STATE_FILE=/data/oauth-state.bin      # optional: keep sign-ins across restarts
GLPI_APP_TOKEN=...                              # if your GLPI API client requires one
```

In claude.ai: *Settings > Connectors > Add custom connector* and enter `https://mcp.example.com/mcp`.
Each person is sent to a sign-in page where they paste their **own GLPI API token**; from then on Claude
acts in GLPI with that person's rights. No service account is needed in this mode.

How it is protected:
- OAuth 2.1 with dynamic client registration, PKCE (S256) and single-attempt authorization codes.
- Only allowed apps receive codes: redirect URIs must be on `MCP_OAUTH_REDIRECT_HOSTS` (default `claude.ai`,
  `claude.com`) or loopback for local apps. The sign-in page shows which host will get access.
- Access tokens expire (default 1 hour); refresh tokens rotate on every use (default 30 days) and a reused
  refresh token signs the whole connection out; a sign-in ends after `MCP_OAUTH_MAX_GRANT_DAYS` (default 90)
  however often it is refreshed; revoking either token signs the connection out.
- At most 10 active connections per GLPI user; registered apps that never sign anyone in are forgotten
  after 7 days.
- Tokens are stored as SHA-256 hashes. The optional state file is encrypted with AES-256-GCM using a key
  derived from `MCP_OAUTH_SECRET`; GLPI tokens are never written to disk in clear text.
- The sign-in form is sealed (encrypted and authenticated), rate limited (10 failed attempts per 15 minutes
  per address) and served with a strict Content-Security-Policy.
- Users revoke access at any time by regenerating their API token in GLPI.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `GLPI_URL` | — | GLPI root URL (required) |
| `GLPI_API_MODE` | `auto` | `auto`, `legacy` or `hlapi` |
| `GLPI_APP_TOKEN` | — | Legacy API client App-Token, if defined |
| `GLPI_USER_TOKEN` | — | Service account API token (legacy API) |
| `GLPI_USERNAME` / `GLPI_PASSWORD` | — | OAuth password grant user; also legacy Basic auth |
| `GLPI_OAUTH_CLIENT_ID` / `GLPI_OAUTH_CLIENT_SECRET` | — | High-Level API OAuth client |
| `GLPI_OAUTH_USERNAME` / `GLPI_OAUTH_PASSWORD` | — | Password grant user, when different from the above |
| `GLPI_OAUTH_SCOPE` | `api` | OAuth scope(s) |
| `GLPI_HLAPI_VERSION` | `auto` | `auto` = newest 2.x offered (else newest), or exact `2.3`, `3.0`... |
| `GLPI_READ_ONLY` | `true` | Register write tools only when `false` |
| `GLPI_ALLOW_DELETE` | `false` | Register the delete tool |
| `GLPI_TIMEOUT_MS` | `30000` | Timeout per GLPI request |
| `GLPI_MAX_LIMIT` | `100` | Max rows per list/search call |
| `GLPI_MAX_FILE_MB` | `10` | Max attachment size downloaded or uploaded |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `MCP_HTTP_HOST` / `MCP_HTTP_PORT` | `127.0.0.1` / `8000` | HTTP listen address (`0.0.0.0` in Docker) |
| `MCP_AUTH_MODE` | `token` | `token` (static bearer) or `oauth` (per-user sign-in) |
| `MCP_AUTH_TOKEN` | — | Bearer token required on `/mcp` in token mode |
| `MCP_ALLOW_USER_TOKENS` | `false` | Token mode: accept `X-GLPI-User-Token` to act as that user |
| `MCP_PUBLIC_URL` | — | Public https URL of the server (required for OAuth) |
| `MCP_OAUTH_SECRET` | — | 32+ random characters (required for OAuth) |
| `MCP_OAUTH_STATE_FILE` | — | Encrypted file to keep sign-ins across restarts |
| `MCP_OAUTH_ACCESS_TTL` / `MCP_OAUTH_REFRESH_TTL` | `3600` / `2592000` | Token lifetimes, seconds |
| `MCP_OAUTH_MAX_GRANT_DAYS` | `90` | A sign-in ends after this many days, even if refreshed |
| `MCP_OAUTH_REDIRECT_HOSTS` | `claude.ai,claude.com` | Hosts (and their subdomains) allowed to receive codes; `*` = any. Loopback is always allowed |
| `MCP_ALLOWED_ORIGINS` | — | Allowed browser `Origin` values, comma-separated |
| `MCP_TRUST_PROXY` | `false` | `true` or a hop count when behind a reverse proxy |

## Security notes

- Read-only by default; deleting needs two explicit switches.
- GLPI enforces the acting user's profile and entities on every call; prefer per-user identity over a
  powerful shared account.
- Secrets come from the environment only and are never logged.
- HTTP mode refuses to start without authentication (unless `MCP_ALLOW_NO_AUTH=true` for local tests),
  compares tokens in constant time, and binds to `127.0.0.1` unless told otherwise.
- Itemtypes, file names and raw paths are validated (no path traversal); attachments have a size cap.
- Rich text from GLPI is converted to plain text; links are kept only for http, https, mailto and relative URLs.

## Development

```sh
npm run dev                         # run from source (tsx)
npm test                            # vitest, HTTP mocked
npm run ci                          # typecheck + tests + build (same as CI)
npx @modelcontextprotocol/inspector node dist/index.js   # try the tools interactively
```

```
src/
  index.ts         entry point (stdio | http)
  http.ts          Streamable HTTP transport: token and OAuth modes
  server.ts        MCP server
  tools.ts         tool definitions (API-agnostic)
  prompts.ts       slash-command workflows
  resolve.ts       names -> IDs
  text.ts          GLPI HTML -> readable text
  config.ts        environment
  oauth/           authorization server, encrypted store, sign-in page
  glpi/
    types.ts       backend contract
    legacy.ts      /apirest.php client (session, search engine, documents, approvals...)
    hlapi.ts       /api.php client (OAuth2, version pinning, RSQL)
    factory.ts     auto-detection, legacy fallback, per-user session pool
    similar.ts     keyword extraction and ranking
    stats.ts       service desk metrics
```

## Contributing

Branches, pull requests and commit conventions: [CONTRIBUTING.md](CONTRIBUTING.md) (Spanish). Report
vulnerabilities privately to **security@zylarion.io** — see [SECURITY.md](SECURITY.md).

## Roadmap

- High-Level API coverage for attachments, approvals, SLA and statistics (no legacy fallback needed)
- Ticket templates and mandatory fields per category
- MCP resources (tickets and KB articles as attachable context)

## License

MIT — made by [Zylarion](https://zylarion.io) for the GLPI community.
