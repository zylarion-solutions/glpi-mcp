import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { BackendProvider } from "../src/glpi/factory.js";
import type { FetchLike } from "../src/glpi/http.js";
import { createHttpApp, type HttpApp } from "../src/http.js";
import { createServer } from "../src/server.js";
import { config, legacyGlpi, mockFetch } from "./helpers.js";

async function connect(env: Record<string, string>, fetchImpl: FetchLike = mockFetch(() => undefined).fetch) {
  const cfg = config({ GLPI_USER_TOKEN: "ut", ...env });
  const server = createServer(cfg, new BackendProvider(cfg, fetchImpl));
  const client = new Client({ name: "test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

describe("tool registration", () => {
  it("is read-only by default", async () => {
    const client = await connect({});
    const tools = (await client.listTools()).tools;
    const names = tools.map((t) => t.name);
    for (const n of ["glpi_my_tickets", "glpi_sla_at_risk", "glpi_find_similar", "glpi_get_attachment", "glpi_pending_approvals", "glpi_asset_context", "glpi_ticket_stats"]) {
      expect(names).toContain(n);
    }
    expect(names).not.toContain("glpi_create_ticket");
    expect(names).not.toContain("glpi_delete_item");
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });

  it("adds write tools with GLPI_READ_ONLY=false, and delete only when allowed", async () => {
    const rw = (await (await connect({ GLPI_READ_ONLY: "false" })).listTools()).tools.map((t) => t.name);
    for (const n of ["glpi_create_ticket", "glpi_upload_attachment", "glpi_request_approval", "glpi_answer_approval"]) expect(rw).toContain(n);
    expect(rw).not.toContain("glpi_delete_item");
    const del = (await (await connect({ GLPI_READ_ONLY: "false", GLPI_ALLOW_DELETE: "true" })).listTools()).tools;
    expect(del.find((t) => t.name === "glpi_delete_item")?.annotations?.destructiveHint).toBe(true);
  });

  it("offers service desk prompts", async () => {
    const client = await connect({});
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
    expect(prompts).toEqual(["triage", "daily_summary", "shift_handover", "new_incident", "review_approvals"]);
    const p = await client.getPrompt({ name: "new_incident", arguments: { description: "Outlook keeps asking for my password" } });
    const text = (p.messages[0].content as { text: string }).text;
    expect(text).toContain("glpi_find_similar");
    expect(text).toContain("read-only");
  });
});

describe("tool calls", () => {
  it("returns JSON text", async () => {
    const { fetch } = legacyGlpi((c) =>
      c.url.pathname.endsWith("/search/Computer") ? { body: { totalcount: 1, data: [{ "1": "PC-001", "2": 3 }] } } : undefined,
    );
    const client = await connect({}, fetch);
    const res = (await client.callTool({ name: "glpi_search_items", arguments: { itemtype: "Computer", query: "PC" } })) as any;
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0].text).items[0]).toMatchObject({ id: 3, name: "PC-001" });
  });

  it("resolves names to IDs, and returns candidates when a name is ambiguous", async () => {
    const { fetch, calls } = legacyGlpi((c) => {
      if (c.url.pathname.endsWith("/search/Group")) return { body: { totalcount: 1, data: [{ "1": "Service Desk", "2": 4 }] } };
      if (c.url.pathname.endsWith("/search/User")) {
        return { body: { totalcount: 2, data: [{ "1": "mario.a", "2": 12 }, { "1": "mario.b", "2": 13 }] } };
      }
      if (c.url.pathname.endsWith("/search/Ticket")) return { body: { totalcount: 0, data: [] } };
      return undefined;
    });
    const client = await connect({}, fetch);
    const ok = (await client.callTool({ name: "glpi_search_tickets", arguments: { assigned_group: "service desk" } })) as any;
    expect(ok.isError).toBeFalsy();
    expect(decodeURIComponent(calls.at(-1)!.url.search)).toContain("[field]=8&criteria[1][searchtype]=equals&criteria[1][value]=4");
    const ambiguous = (await client.callTool({ name: "glpi_search_tickets", arguments: { assigned_user: "mario" } })) as any;
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.content[0].text).toContain("12 = mario.a; 13 = mario.b");
  });

  it("returns image attachments as images", async () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const { fetch } = legacyGlpi((c) =>
      c.url.pathname.endsWith("/Document/5")
        ? c.url.searchParams.get("alt") === "media"
          ? { raw: png }
          : { body: { id: 5, filename: "shot.png", mime: "image/png" } }
        : undefined,
    );
    const client = await connect({}, fetch);
    const res = (await client.callTool({ name: "glpi_get_attachment", arguments: { document_id: 5 } })) as any;
    expect(res.content[0].text).toBe("Document 5: shot.png (image/png, 8 bytes)");
    expect(res.content[1]).toEqual({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
  });

  it("checks upload input before calling GLPI", async () => {
    const client = await connect({ GLPI_READ_ONLY: "false", GLPI_MAX_FILE_MB: "1" });
    const both = (await client.callTool({
      name: "glpi_upload_attachment",
      arguments: { id: 1, filename: "a.txt", text: "x", content_base64: "eA==" },
    })) as any;
    expect(both.content[0].text).toContain("exactly one of text or content_base64");
    const path = (await client.callTool({ name: "glpi_upload_attachment", arguments: { id: 1, filename: "../a.txt", text: "x" } })) as any;
    expect(path.isError).toBe(true);
  });

  it("reports GLPI errors as tool errors instead of crashing", async () => {
    const { fetch } = mockFetch((c) =>
      c.url.pathname.endsWith("/initSession") ? { status: 401, body: ["ERROR_LOGIN_PARAMETERS_MISSING", "bad token"] } : undefined,
    );
    const client = await connect({}, fetch);
    const res = (await client.callTool({ name: "glpi_whoami", arguments: {} })) as any;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/401.*bad token/);
  });
});

// ------------------------------------------------------------------- HTTP

const ACCEPT = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
};
const CALL_WHOAMI = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "glpi_whoami", arguments: {} } };

/** Read a JSON-RPC answer whether it came as JSON or as an SSE event. */
async function rpc(res: Response): Promise<any> {
  const text = await res.text();
  const data = text.startsWith("event:") || text.startsWith("data:") ? text.split("\n").find((l) => l.startsWith("data:"))!.slice(5) : text;
  return JSON.parse(data);
}

let running: Array<{ server: Server; http: HttpApp }> = [];
afterEach(async () => {
  for (const r of running) {
    r.server.close();
    await r.http.close();
  }
  running = [];
});

async function listen(env: Record<string, string>, fetchImpl: FetchLike) {
  const cfg = config({ MCP_TRANSPORT: "http", ...env });
  const http = createHttpApp(cfg, { fetchImpl });
  const server = http.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  running.push({ server, http });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("HTTP transport, token mode", () => {
  it("requires an auth token to start", () => {
    expect(() => createHttpApp(config({ GLPI_USER_TOKEN: "ut", MCP_TRANSPORT: "http" }))).toThrow(/MCP_AUTH_TOKEN/);
  });

  it("rejects requests without the bearer token and serves MCP with it", async () => {
    const base = await listen({ GLPI_USER_TOKEN: "ut", MCP_AUTH_TOKEN: "secret-123" }, mockFetch(() => undefined).fetch);
    const denied = await fetch(`${base}/mcp`, { method: "POST", headers: ACCEPT, body: JSON.stringify(INIT) });
    expect(denied.status).toBe(401);
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...ACCEPT, Authorization: "Bearer secret-123" },
      body: JSON.stringify(INIT),
    });
    expect(res.status).toBe(200);
    expect((await rpc(res)).result.serverInfo.name).toBe("glpi-mcp");
  });

  it("acts as the user who sends X-GLPI-User-Token, only when enabled", async () => {
    const { fetch: f, calls } = legacyGlpi(() => undefined, { glpiID: 21, glpiname: "ana", glpigroups: [] });
    const headers = { ...ACCEPT, Authorization: "Bearer secret-123", "X-GLPI-User-Token": "anaPersonalToken12345678" };

    const off = await listen({ GLPI_USER_TOKEN: "ut", MCP_AUTH_TOKEN: "secret-123" }, f);
    expect((await fetch(`${off}/mcp`, { method: "POST", headers, body: JSON.stringify(CALL_WHOAMI) })).status).toBe(400);

    const on = await listen({ GLPI_USER_TOKEN: "ut", MCP_AUTH_TOKEN: "secret-123", MCP_ALLOW_USER_TOKENS: "true" }, f);
    const res = await fetch(`${on}/mcp`, { method: "POST", headers, body: JSON.stringify(CALL_WHOAMI) });
    const body = await rpc(res);
    expect(JSON.parse(body.result.content[0].text)).toMatchObject({ user_id: 21, login: "ana" });
    expect(calls.find((c) => c.url.pathname.endsWith("/initSession"))!.headers.authorization).toBe("user_token anaPersonalToken12345678");
  });
});

describe("HTTP transport, OAuth mode", () => {
  const oauthEnv = {
    MCP_AUTH_MODE: "oauth",
    MCP_PUBLIC_URL: "http://localhost:8000",
    MCP_OAUTH_SECRET: "x".repeat(40),
  };
  const GOOD = "anaPersonalToken12345678";
  const glpi = () =>
    mockFetch((c) => {
      const auth = c.headers.authorization;
      if (c.url.pathname.endsWith("/initSession")) {
        return auth === `user_token ${GOOD}` ? { body: { session_token: "st-ana" } } : { status: 401, body: ["ERROR_GLPI_LOGIN_USER_TOKEN", "bad"] };
      }
      if (c.url.pathname.endsWith("/getFullSession")) return { body: { session: { glpiID: 21, glpiname: "ana", glpigroups: [] } } };
      if (c.url.pathname.endsWith("/killSession")) return { body: {} };
      return undefined;
    });

  it("needs a public URL and a strong secret", () => {
    expect(() => createHttpApp(config({ MCP_TRANSPORT: "http", MCP_AUTH_MODE: "oauth" }))).toThrow(/MCP_PUBLIC_URL/);
    expect(() =>
      createHttpApp(config({ MCP_TRANSPORT: "http", MCP_AUTH_MODE: "oauth", MCP_PUBLIC_URL: "http://localhost", MCP_OAUTH_SECRET: "short" })),
    ).toThrow(/MCP_OAUTH_SECRET/);
  });

  it("runs the full connector flow: register, sign in with a GLPI token, PKCE, refresh, revoke", async () => {
    const { fetch: f, calls } = glpi();
    const base = await listen(oauthEnv, f);

    // Unauthenticated MCP calls point to the protected resource metadata.
    const anon = await fetch(`${base}/mcp`, { method: "POST", headers: ACCEPT, body: JSON.stringify(INIT) });
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toContain("resource_metadata=");

    const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(meta.code_challenge_methods_supported).toContain("S256");
    expect(meta.registration_endpoint).toBe("http://localhost:8000/register");

    const redirect = "https://claude.ai/api/mcp/auth_callback";
    const reg = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: "none", client_name: "Claude <test>" }),
    });
    expect(reg.status).toBe(201);
    const { client_id } = await reg.json();

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorize = new URL(`${base}/authorize`);
    for (const [k, v] of Object.entries({ response_type: "code", client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "s1", scope: "glpi" })) {
      authorize.searchParams.set(k, v);
    }
    const page = await fetch(authorize, { redirect: "manual" });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await page.text();
    expect(html).toContain("Claude &lt;test&gt;"); // client name is escaped
    const sealed = html.match(/name="request" value="([^"]+)"/)![1];

    const login = (request: string, token: string) =>
      fetch(`${base}/login`, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ request, glpi_user_token: token }).toString(),
      });

    const bad = await login(sealed, "wrongTokenAAAAAAAAAAAAAAA");
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("GLPI did not accept this token");
    const flipped = sealed.slice(0, 40) + (sealed[40] === "A" ? "B" : "A") + sealed.slice(41);
    const tampered = await login(flipped, GOOD);
    expect(tampered.status).toBe(400);

    const ok = await login(sealed, GOOD);
    expect(ok.status).toBe(302);
    const back = new URL(ok.headers.get("location")!);
    expect(`${back.origin}${back.pathname}`).toBe(redirect);
    expect(back.searchParams.get("state")).toBe("s1");
    const code = back.searchParams.get("code")!;

    const token = async (params: Record<string, string>) =>
      fetch(`${base}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id, ...params }).toString(),
      });
    expect((await token({ grant_type: "authorization_code", code, code_verifier: "wrong".repeat(10), redirect_uri: redirect })).status).toBe(400);
    const issued = await token({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirect });
    // The failed attempt above already consumed the single-use code.
    expect(issued.status).toBe(400);

    // Start again, this time with the right verifier on the first try.
    const page2 = await (await fetch(authorize, { redirect: "manual" })).text();
    const code2 = new URL((await login(page2.match(/name="request" value="([^"]+)"/)![1], GOOD)).headers.get("location")!).searchParams.get("code")!;
    const tokens = await (await token({ grant_type: "authorization_code", code: code2, code_verifier: verifier, redirect_uri: redirect })).json();
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.scope).toBe("glpi");

    // The MCP call runs as Ana, with her own GLPI token.
    const call = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...ACCEPT, Authorization: `Bearer ${tokens.access_token}` },
      body: JSON.stringify(CALL_WHOAMI),
    });
    expect(JSON.parse((await rpc(call)).result.content[0].text)).toMatchObject({ user_id: 21, login: "ana" });
    expect(calls.filter((c) => c.url.pathname.endsWith("/initSession")).every((c) => c.headers.authorization !== "user_token ut")).toBe(true);

    // Refresh rotates: the old refresh token stops working.
    const refreshed = await (await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token })).json();
    expect(refreshed.access_token).toBeTruthy();
    expect((await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token })).status).toBe(400);

    // Revoking signs the connection out.
    const revoke = await fetch(`${base}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id, token: refreshed.refresh_token }).toString(),
    });
    expect(revoke.status).toBe(200);
    const after = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...ACCEPT, Authorization: `Bearer ${refreshed.access_token}` },
      body: JSON.stringify(CALL_WHOAMI),
    });
    expect(after.status).toBe(401);
  });
});
