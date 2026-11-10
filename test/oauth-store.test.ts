import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashToken, OAuthStore } from "../src/oauth/store.js";

const SECRET = "s".repeat(40);
let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function sample(store: OAuthStore) {
  store.clients.set("c1", { client_id: "c1", redirect_uris: ["https://claude.ai/cb"] } as any);
  store.grants.set("g1", { clientId: "c1", glpiUserToken: "anaPersonalToken12345678", userId: 21, scopes: ["glpi"], createdAt: Date.now() });
  store.access.set(hashToken("access-1"), { grantId: "g1", clientId: "c1", expiresAt: Date.now() + 60_000 });
  store.refresh.set(hashToken("refresh-1"), { grantId: "g1", clientId: "c1", expiresAt: Date.now() + 600_000 });
}

describe("OAuthStore", () => {
  it("persists encrypted state that survives a restart", () => {
    dir = mkdtempSync(join(tmpdir(), "glpi-mcp-"));
    const file = join(dir, "state.bin");
    const a = new OAuthStore(SECRET, file);
    sample(a);
    a.saveNow();

    const raw = readFileSync(file);
    expect(raw.includes(Buffer.from("anaPersonalToken12345678"))).toBe(false);
    expect(raw.includes(Buffer.from("access-1"))).toBe(false);
    expect(statSync(file).mode & 0o077).toBe(0);

    const b = new OAuthStore(SECRET, file);
    expect(b.grants.get("g1")?.glpiUserToken).toBe("anaPersonalToken12345678");
    expect(b.access.has(hashToken("access-1"))).toBe(true);
    expect(() => new OAuthStore("t".repeat(40), file)).toThrow(/wrong MCP_OAUTH_SECRET/);
  });

  it("expires tokens and drops grants nobody can use any more", () => {
    dir = mkdtempSync(join(tmpdir(), "glpi-mcp-"));
    const s = new OAuthStore(SECRET);
    sample(s);
    s.sweep(Date.now() + 120_000); // access expired, refresh still valid
    expect(s.access.size).toBe(0);
    expect(s.grants.has("g1")).toBe(true);
    s.sweep(Date.now() + 1_000_000); // refresh expired too
    expect(s.refresh.size).toBe(0);
    expect(s.grants.size).toBe(0);
  });

  it("revokes a grant with all its tokens", () => {
    dir = mkdtempSync(join(tmpdir(), "glpi-mcp-"));
    const s = new OAuthStore(SECRET);
    sample(s);
    s.revokeGrant("g1");
    expect([s.grants.size, s.access.size, s.refresh.size]).toEqual([0, 0, 0]);
  });
});
