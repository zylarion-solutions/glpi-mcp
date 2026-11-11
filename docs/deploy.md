# Deploy next to GLPI (one server, OAuth, the whole team)

This guide runs glpi-mcp on the same server as GLPI, behind the web server that already publishes GLPI.
Everyone on the team adds it as a connector in Claude and signs in with their own GLPI API token, so each
person acts with their own GLPI rights.

```
Claude (claude.ai, desktop, mobile)
        │  HTTPS + OAuth
        ▼
mcp.servicedesk.example.com ── Apache/Nginx (TLS) ──► glpi-mcp 127.0.0.1:8000
                                                          │  GLPI legacy API, local
                                                          ▼
                                       GLPI (servicedesk.example.com) on 127.0.0.1
```

Why this layout:
- **No new port is opened.** HTTPS (443) is already open for GLPI.
- **The GLPI API is never exposed.** The MCP server calls it from the same host, so GLPI's default API
  client, *full access from localhost*, is all you need.
- **The MCP server listens on 127.0.0.1 only.** The web server is its only way in.

Requirements: a Linux server running GLPI 9.5 or newer, Docker with the compose plugin, Apache or Nginx,
certbot, and a DNS name for the MCP server.

## 1. GLPI

1. Go to *Setup > General > API* and set:
   - **Enable Rest API**: Yes
   - **Enable login with external token**: Yes
   - **Enable login with credentials**: No (not needed)
2. In the API clients list, check that **full access from localhost** is active. Its IPv4 range is
   `127.0.0.1` and it has no App-Token. Leave it as it is.
3. Each user finds their token in *My settings > Remote access keys > API token* and regenerates it if it is
   empty. Their GLPI profile decides what they can do through Claude.

Check from the server that the API answers locally. Replace the host name and the token:

```sh
curl -s --resolve servicedesk.example.com:443:127.0.0.1 \
  -H "Authorization: user_token YOUR_API_TOKEN" \
  https://servicedesk.example.com/apirest.php/initSession
# expected: {"session_token":"..."}
```

If GLPI also answers on plain HTTP locally, `curl -s -H "Authorization: user_token ..." http://127.0.0.1/apirest.php/initSession`
works too, and you can use `GLPI_URL=http://127.0.0.1` below.

## 2. DNS

Create a record for the MCP server (for example `mcp.servicedesk.example.com`) that points to the same public
IP as GLPI.

## 3. Run glpi-mcp

```sh
sudo git clone https://github.com/zylarion-solutions/glpi-mcp.git /opt/glpi-mcp
cd /opt/glpi-mcp/deploy
sudo cp .env.example .env
sudo chmod 600 .env
sudo sed -i "s/^MCP_OAUTH_SECRET=.*/MCP_OAUTH_SECRET=$(openssl rand -hex 32)/" .env
sudo nano .env               # GLPI_URL, MCP_PUBLIC_URL
sudo nano docker-compose.yml # extra_hosts: your GLPI host name (or remove it with GLPI_URL=http://127.0.0.1)
sudo docker compose up -d --build
curl -s http://127.0.0.1:8000/healthz   # {"status":"ok",...,"auth":"oauth"}
```

## 4. Publish it over HTTPS

- **Apache:** follow the steps at the top of [`deploy/apache.conf`](../deploy/apache.conf).
- **Nginx:** follow the steps at the top of [`deploy/nginx.conf`](../deploy/nginx.conf).

Then check from outside:

```sh
curl -s https://mcp.servicedesk.example.com/healthz
curl -s https://mcp.servicedesk.example.com/.well-known/oauth-authorization-server | head -c 300
```

## 5. Connect Claude

Each person goes to *Settings > Connectors > Add custom connector*, enters
`https://mcp.servicedesk.example.com/mcp` and connects. A sign-in page asks for their GLPI API token, and the
page shows which app receives access. On Team and Enterprise plans, an owner may need to add the connector
for the organization first.

Try it:
- "Who am I in GLPI?"
- "What's in my queue?"
- `/daily_summary`

## Operating it

| Task | How |
|---|---|
| Update | `cd /opt/glpi-mcp && sudo git pull && cd deploy && sudo docker compose up -d --build` |
| Logs | `sudo docker compose logs -f` (tokens are never logged) |
| Enable writes | `GLPI_READ_ONLY=false` in `.env`, then `sudo docker compose up -d` |
| Sign one person out | They regenerate their API token in GLPI. Their next call fails and they sign in again |
| Sign everyone out | Change `MCP_OAUTH_SECRET` and restart: the encrypted state can no longer be read. Then delete the volume: `sudo docker compose down && sudo docker volume rm deploy_glpi-mcp-data && sudo docker compose up -d` |
| Back up | Nothing to back up except, optionally, the `glpi-mcp-data` volume. If it is lost, people simply sign in again |

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Sign-in page says GLPI did not accept the token | Login with external token is disabled, the token was regenerated, or the API client does not match `127.0.0.1` (check `GLPI_URL` and `extra_hosts`) |
| `ERROR_APP_TOKEN_PARAMETERS_MISSING` | The API client in use requires an App-Token: set `GLPI_APP_TOKEN` |
| Claude says the connector failed to connect | `https://<host>/.well-known/oauth-protected-resource/mcp` must be reachable from the internet, and `MCP_PUBLIC_URL` must match the host exactly |
| Responses hang or arrive all at once | The proxy is buffering: keep `flushpackets=on` (Apache) or `proxy_buffering off` (Nginx) |
| `redirect_uri host not allowed` | The app is not on `MCP_OAUTH_REDIRECT_HOSTS` |
