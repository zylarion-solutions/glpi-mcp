import { describe, expect, it } from "vitest";
import { BackendProvider, UserBackendPool } from "../src/glpi/factory.js";
import { UnsupportedFeatureError, type GlpiBackend, type ItemRef } from "../src/glpi/types.js";
import { AmbiguousReferenceError, resolveRef } from "../src/resolve.js";
import { config, legacyGlpi, mockFetch } from "./helpers.js";

function fakeBackend(items: ItemRef[]): GlpiBackend {
  return {
    searchItems: async () => ({ start: 0, limit: 15, items }),
    session: async () => ({ userId: 7, groupIds: [] }),
  } as unknown as GlpiBackend;
}

describe("resolveRef", () => {
  it("passes IDs through", async () => {
    const b = fakeBackend([]);
    expect(await resolveRef(b, "User", 12)).toBe(12);
    expect(await resolveRef(b, "User", " 12 ")).toBe(12);
    expect(await resolveRef(b, "User", undefined)).toBeUndefined();
    expect(await resolveRef(b, "User", "me")).toBe(7);
  });

  it("uses a single match, or the one exact match among several", async () => {
    expect(await resolveRef(fakeBackend([{ id: 3, name: "Service Desk" }]), "Group", "service")).toBe(3);
    const many = fakeBackend([
      { id: 12, name: "mgomez", fullname: "Mario Gómez" },
      { id: 13, name: "mgomezr", fullname: "Mario Gómez Ruiz" },
    ]);
    expect(await resolveRef(many, "User", "mario gomez")).toBe(12);
    const tree = fakeBackend([
      { id: 8, name: "Hardware > Laptops" },
      { id: 9, name: "Hardware > Laptops > Batteries" },
    ]);
    expect(await resolveRef(tree, "ITILCategory", "laptops")).toBe(8);
  });

  it("returns the candidates when ambiguous, and a hint when nothing matches", async () => {
    const two = fakeBackend([
      { id: 12, name: "mario.a", fullname: "Mario A" },
      { id: 13, name: "mario.b", fullname: "Mario B" },
    ]);
    const err = await resolveRef(two, "User", "Mario").catch((e) => e);
    expect(err).toBeInstanceOf(AmbiguousReferenceError);
    expect(err.message).toBe('"Mario" matches several User items. Ask the user which one and pass its id: 12 = mario.a / Mario A; 13 = mario.b / Mario B');
    await expect(resolveRef(fakeBackend([]), "Location", "Moon")).rejects.toThrow(/No Location matches "Moon"/);
  });
});

describe("BackendProvider.run", () => {
  const oauthEnv = { GLPI_OAUTH_CLIENT_ID: "c", GLPI_OAUTH_CLIENT_SECRET: "s", GLPI_USERNAME: "u", GLPI_PASSWORD: "p" };
  const glpi11 = () =>
    mockFetch((c) => {
      if (c.url.pathname === "/api.php/") return { body: { api_versions: [{ version: "2.3.0" }] } };
      if (c.url.pathname === "/api.php/token") return { body: { access_token: "t" } };
      if (c.url.pathname.endsWith("/initSession")) return { body: { session_token: "st" } };
      if (c.url.pathname.endsWith("/getFullSession")) return { body: { session: { glpiID: 7, glpigroups: [] } } };
      if (c.url.pathname.endsWith("/apirest.php/search/Ticket")) return { body: { totalcount: 0, data: [] } };
      return undefined;
    });

  it("retries on the legacy API when the High-Level API lacks a feature", async () => {
    const { fetch, calls } = glpi11();
    const p = new BackendProvider(config({ ...oauthEnv, GLPI_USER_TOKEN: "ut" }), fetch);
    const page = await p.run((b) => b.myQueue({ itilType: "Ticket", includeGroups: true, start: 0, limit: 5 }));
    expect(page.total).toBe(0);
    expect((await p.get()).kind).toBe("hlapi");
    expect(calls.some((c) => c.url.pathname === "/apirest.php/search/Ticket")).toBe(true);
  });

  it("explains how to enable a feature when no legacy credentials exist", async () => {
    const oauthOnly = { GLPI_OAUTH_CLIENT_ID: "c", GLPI_OAUTH_CLIENT_SECRET: "s", GLPI_OAUTH_USERNAME: "u", GLPI_OAUTH_PASSWORD: "p" };
    const p = new BackendProvider(config(oauthOnly), glpi11().fetch);
    await expect(p.run((b) => b.itilStats({ itilType: "Ticket", from: "2026-01-01", to: "2026-01-02", maxRows: 10 }))).rejects.toBeInstanceOf(
      UnsupportedFeatureError,
    );
  });
});

describe("UserBackendPool", () => {
  it("keeps one GLPI session per user token and closes idle ones", async () => {
    const { fetch, calls } = legacyGlpi(() => undefined);
    const pool = new UserBackendPool(config({ GLPI_APP_TOKEN: "app" }), fetch, 10, 1000);
    await (await pool.forToken("tokenAAAAAAAAAAAAAAAAAAAA").get()).session();
    await (await pool.forToken("tokenAAAAAAAAAAAAAAAAAAAA").get()).session();
    await (await pool.forToken("tokenBBBBBBBBBBBBBBBBBBBB").get()).session();
    expect(pool.size).toBe(2);
    const inits = calls.filter((c) => c.url.pathname.endsWith("/initSession"));
    expect(inits.map((c) => c.headers.authorization)).toEqual([
      "user_token tokenAAAAAAAAAAAAAAAAAAAA",
      "user_token tokenBBBBBBBBBBBBBBBBBBBB",
    ]);
    expect(inits[0].headers["app-token"]).toBe("app");
    await pool.sweep(Date.now() + 5000);
    expect(pool.size).toBe(0);
    expect(calls.filter((c) => c.url.pathname.endsWith("/killSession"))).toHaveLength(2);
    await pool.close();
  });
});
