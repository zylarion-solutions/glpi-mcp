import { describe, expect, it } from "vitest";
import { LegacyBackend, cleanCell, stripTags } from "../src/glpi/legacy.js";
import { toPhpQuery } from "../src/glpi/http.js";
import { config, mockFetch } from "./helpers.js";

const cfg = config({ GLPI_USER_TOKEN: "ut", GLPI_APP_TOKEN: "at" });

describe("toPhpQuery", () => {
  it("encodes nested criteria PHP-style", () => {
    const qs = toPhpQuery({ criteria: [{ field: 12, value: "notold" }], forcedisplay: [1, 2] });
    expect(decodeURIComponent(qs)).toBe(
      "criteria[0][field]=12&criteria[0][value]=notold&forcedisplay[0]=1&forcedisplay[1]=2",
    );
  });
});

describe("cleanCell", () => {
  it("strips HTML and joins multi values", () => {
    expect(cleanCell('<a href="x">Juan</a>$$$$Ana')).toBe("Juan, Ana");
    expect(cleanCell(["a", "b"])).toBe("a, b");
    expect(cleanCell("")).toBeUndefined();
  });

  it("never leaves a tag rebuilt from nested pieces", () => {
    expect(stripTags("<scr<script>ipt>alert(1)</script>")).toBe("alert(1)");
    expect(stripTags("<<b>script>x")).toBe("x");
    expect(stripTags("a > b < c")).toBe("a  b  c");
    expect(cleanCell('<a href="/front/user.form.php?id=3">Mario</a>')).toBe("Mario");
  });
});

describe("LegacyBackend", () => {
  it("opens a session with user_token and App-Token, then searches tickets", async () => {
    const { fetch, calls } = mockFetch((c) => {
      if (c.url.pathname.endsWith("/initSession")) return { body: { session_token: "st1" } };
      if (c.url.pathname.endsWith("/search/Ticket")) {
        return {
          body: {
            totalcount: 1,
            data: [{ "1": "VPN caída", "2": 42, "12": 2, "3": 4, "14": 1, "5": "<a>Mario</a>", "19": "2026-11-01" }],
          },
        };
      }
    });
    const b = new LegacyBackend(cfg, fetch);
    const page = await b.listItil({ itilType: "Ticket", openOnly: true, text: "VPN", start: 0, limit: 10 });

    expect(calls[0].headers.authorization).toBe("user_token ut");
    expect(calls[0].headers["app-token"]).toBe("at");
    expect(calls[1].headers["session-token"]).toBe("st1");
    const q = decodeURIComponent(calls[1].url.search);
    expect(q).toContain("criteria[0][criteria][0][value]=notold");
    expect(q).toContain("criteria[1][searchtype]=contains");
    expect(q).toContain("range=0-9");
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({
      id: 42,
      name: "VPN caída",
      status: "processing (assigned)",
      priority: "high",
      type: "incident",
      assigned_user: "Mario",
    });
  });

  it("renews an expired session once", async () => {
    let inits = 0;
    let first = true;
    const { fetch } = mockFetch((c) => {
      if (c.url.pathname.endsWith("/initSession")) return { body: { session_token: `st${++inits}` } };
      if (c.url.pathname.endsWith("/Ticket/7")) {
        if (first) {
          first = false;
          return { status: 401, body: ["ERROR_SESSION_TOKEN_INVALID", "expired"] };
        }
        return { body: { id: 7, status: 1, priority: 3 } };
      }
    });
    const b = new LegacyBackend(cfg, fetch);
    const t = (await b.getItil("Ticket", 7)) as Record<string, unknown>;
    expect(inits).toBe(2);
    expect(t.status_label).toBe("new");
  });

  it("creates a ticket with assignment fields and adds followups via ITILFollowup", async () => {
    const { fetch, calls } = mockFetch((c) => {
      if (c.url.pathname.endsWith("/initSession")) return { body: { session_token: "s" } };
      if (c.method === "POST") return { status: 201, body: { id: 99, message: "ok" } };
    });
    const b = new LegacyBackend(cfg, fetch);
    await b.createItil({ itilType: "Ticket", name: "x", content: "y", urgency: 4, assignedGroupId: 3, categoryId: 8 });
    await b.addFollowup("Ticket", 99, "hola", true);
    await b.addTeamMember("Change", 5, "Group", 2, "assigned");

    expect(JSON.parse(calls[1].body!)).toEqual({
      input: { name: "x", content: "y", urgency: 4, itilcategories_id: 8, _groups_id_assign: 3 },
    });
    expect(calls[2].url.pathname).toBe("/apirest.php/ITILFollowup");
    expect(JSON.parse(calls[2].body!).input).toEqual({ itemtype: "Ticket", items_id: 99, content: "hola", is_private: 1 });
    expect(calls[3].url.pathname).toBe("/apirest.php/Change_Group");
    expect(JSON.parse(calls[3].body!).input).toEqual({ changes_id: 5, groups_id: 2, type: 2 });
  });

  it("rejects unsafe itemtypes", async () => {
    const b = new LegacyBackend(cfg, mockFetch(() => undefined).fetch);
    await expect(b.getItem("../Ticket", 1)).rejects.toThrow(/Invalid itemtype/);
  });
});
