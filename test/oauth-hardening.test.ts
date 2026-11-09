import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { UserBackendPool } from "../src/glpi/factory.js";
import { createHttpApp, type HttpApp } from "../src/http.js";
import { GlpiOAuthProvider, MAX_GRANTS_PER_USER } from "../src/oauth/provider.js";
import { hashToken, OAuthStore } from "../src/oauth/store.js";
import { config, mockFetch } from "./helpers.js";

const GOOD = "anaPersonalToken12345678";
const glpi = () =>
  mockFetch((c) => {
    if (c.url.pathname.endsWith("/initSession")) {
      return c.headers.authorization === `user_token ${GOOD}` ? { body: { session_token: "st" } } : { status: 401, body: ["ERROR_GLPI_LOGIN_USER_TOKEN", "bad"] };
    }
    if (c.url.pathname.endsWith("/getFullSession")) return { body: { session: { glpiID: 21, glpiname: "ana", glpigroups: [] } } };
    if (c.url.pathname.endsWith("/killSession")) return { body: {} };
    return undefined;
  });

let running: Array<{ server: Server; http: HttpApp }> = [];
afterEach(async () => {
  for (const r of running) {
    r.server.close();
    await r.http.close();
  }
  running = [];
});

async function start(env: Record<string, string> = {}) {
  const store = new OAuthStore("x".repeat(40));
  const cfg = config({
    MCP_TRANSPORT: "http",
    MCP_AUTH_MODE: "oauth",
    MCP_PUBLIC_URL: "http://localhost:8000",
    MCP_OAUTH_SECRET: "x".repeat(40),
    ...env,
  });
  const http = createHttpApp(cfg, { fetchImpl: glpi().fetch, store });
  const server = http.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  running.push({ server, http });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const register = (redirect_uris: string[]) =>
    fetch(`${base}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris, token_endpoint_auth_method: "none", client_name: "Claude" }),
    });

  /** Authorize, sign in and exchange the code; returns tokens and the login page details. */
  const connect = async (clientId: string, redirect: string, extra: Record<string, string> = {}) => {
    const verifier = randomBytes(32).toString("base64url");
    const url = new URL(`${base}/authorize`);
    const params = {
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirect,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state: "s",
      ...extra,
    };
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const page = await fetch(url, { redirect: "manual" });
    if (page.status !== 200) return { page };
    const html = await page.text();
    const sealed = html.match(/name="request" value="([^"]+)"/)![1];
    const login = await fetch(`${base}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request: sealed, glpi_user_token: GOOD }).toString(),
    });
    const location = login.headers.get("location");
    const code = location ? new URL(location).searchParams.get("code") : null;
    const tokens = code
      ? await (await token({ client_id: clientId, grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirect })).json()
      : undefined;
    return { page, html, csp: page.headers.get("content-security-policy"), login, tokens };
  };

  const token = (params: Record<string, string>) =>
    fetch(`${base}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });

  const whoami = (access: string) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${access}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "glpi_whoami", arguments: {} } }),
    });

  return { base, store, register, connect, token, whoami };
}

describe("OAuth hardening", () => {
  it("only lets allowed hosts and loopback receive codes", async () => {
    const s = await start();
    const evil = await s.register(["https://evil.example/cb"]);
    expect(evil.status).toBe(400);
    expect((await evil.json()).error).toBe("invalid_client_metadata");
    expect((await s.register(["https://claude.ai/api/mcp/auth_callback"])).status).toBe(201);
    expect((await s.register(["http://localhost/callback"])).status).toBe(201);
    expect((await s.register(["http://claude.ai/cb"])).status).toBe(400); // https only for remote hosts

    const open = await start({ MCP_OAUTH_REDIRECT_HOSTS: "*" });
    expect((await open.register(["https://evil.example/cb"])).status).toBe(201);
  });

  it("shows where access goes and lets the browser follow the redirect", async () => {
    const s = await start();
    const { client_id } = await (await s.register(["https://claude.ai/api/mcp/auth_callback"])).json();
    const r = await s.connect(client_id, "https://claude.ai/api/mcp/auth_callback");
    expect(r.html).toContain("Access will be given to <b>claude.ai</b>");
    expect(r.csp).toContain("form-action 'self' https://claude.ai;");
    expect(r.tokens.access_token).toBeTruthy();
  });

  it("accepts a local app on any port (RFC 8252)", async () => {
    const s = await start();
    const { client_id } = await (await s.register(["http://localhost/callback"])).json();
    const r = await s.connect(client_id, "http://localhost:53122/callback");
    expect(r.login!.status).toBe(302);
    expect(r.login!.headers.get("location")).toMatch(/^http:\/\/localhost:53122\/callback\?code=/);
    expect(r.tokens.access_token).toBeTruthy();
  });

  it("refuses tokens for another resource", async () => {
    const s = await start();
    const { client_id } = await (await s.register(["https://claude.ai/cb"])).json();
    const r = await s.connect(client_id, "https://claude.ai/cb", { resource: "https://other.example/mcp" });
    expect(r.page.status).toBe(302);
    expect(r.page.headers.get("location")).toContain("error=invalid_request");
  });

  it("signs the connection out when a rotated refresh token is reused", async () => {
    const s = await start();
    const { client_id } = await (await s.register(["https://claude.ai/cb"])).json();
    const { tokens } = await s.connect(client_id, "https://claude.ai/cb");
    const next = await (await s.token({ client_id, grant_type: "refresh_token", refresh_token: tokens.refresh_token })).json();
    expect((await s.whoami(next.access_token)).status).toBe(200);
    // An attacker replays the old refresh token...
    expect((await s.token({ client_id, grant_type: "refresh_token", refresh_token: tokens.refresh_token })).status).toBe(400);
    // ...and the legitimate session is revoked too.
    expect((await s.whoami(next.access_token)).status).toBe(401);
    expect((await s.token({ client_id, grant_type: "refresh_token", refresh_token: next.refresh_token })).status).toBe(400);
  });

  it("expires a sign-in after the maximum grant age, even if refreshed", async () => {
    const s = await start();
    const { client_id } = await (await s.register(["https://claude.ai/cb"])).json();
    const { tokens } = await s.connect(client_id, "https://claude.ai/cb");
    for (const g of s.store.grants.values()) g.createdAt -= 91 * 24 * 3600 * 1000;
    expect((await s.whoami(tokens.access_token)).status).toBe(401);
    const res = await s.token({ client_id, grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    expect(res.status).toBe(400);
    expect(s.store.grants.size).toBe(0);
  });
});

describe("OAuth limits", () => {
  it("keeps at most MAX_GRANTS_PER_USER connections per GLPI user", async () => {
    const store = new OAuthStore("x".repeat(40));
    const p = new GlpiOAuthProvider(store, {
      secret: "x".repeat(40),
      glpiUrl: "https://glpi.test",
      accessTokenTtl: 3600,
      refreshTokenTtl: 86400,
      maxGrantAge: 86400,
      redirectHosts: ["claude.ai"],
      resourceUrl: "http://localhost/mcp",
      validateToken: async () => ({ userId: 21 }),
    });
    const client = { client_id: "c1", redirect_uris: ["https://claude.ai/cb"] } as any;
    store.clients.set("c1", client);
    for (let i = 0; i < MAX_GRANTS_PER_USER + 3; i++) {
      const location = await p.completeLogin(
        p.sealRequest({ clientId: "c1", redirectUri: "https://claude.ai/cb", codeChallenge: "x", scopes: ["glpi"], exp: Date.now() + 60_000 }),
        GOOD,
      );
      await p.exchangeAuthorizationCode(client, new URL(location).searchParams.get("code")!);
    }
    expect(store.grants.size).toBe(MAX_GRANTS_PER_USER);
  });

  it("forgets clients that never signed anyone in, and rotated tokens once expired", () => {
    const store = new OAuthStore("x".repeat(40));
    const now = Date.now();
    store.clients.set("old", { client_id: "old", client_id_issued_at: Math.floor((now - 8 * 86400_000) / 1000), redirect_uris: [] } as any);
    store.clients.set("new", { client_id: "new", client_id_issued_at: Math.floor(now / 1000), redirect_uris: [] } as any);
    store.rotated.set(hashToken("r"), { grantId: "g", clientId: "new", expiresAt: now - 1 });
    store.sweep(now);
    expect([...store.clients.keys()]).toEqual(["new"]);
    expect(store.rotated.size).toBe(0);
  });

  it("drops a user token GLPI rejects from the session pool", async () => {
    const rejecting = mockFetch((c) =>
      c.url.pathname.endsWith("/initSession") ? { status: 401, body: ["ERROR_GLPI_LOGIN_USER_TOKEN", "bad"] } : undefined,
    );
    const pool = new UserBackendPool(config(), rejecting.fetch);
    await expect(pool.forToken("madeUpTokenAAAAAAAAAAAAA").run((b) => b.session())).rejects.toThrow(/401/);
    expect(pool.size).toBe(0);
    await pool.close();
  });
});
