import { describe, expect, it } from "vitest";
import { LegacyBackend } from "../src/glpi/legacy.js";
import { config, legacyGlpi, query } from "./helpers.js";

const cfg = config({ GLPI_USER_TOKEN: "ut" });

const ticketRow = (id: number, extra: Record<string, unknown> = {}) => ({
  "1": `Ticket ${id}`,
  "2": id,
  "12": 2,
  "3": 4,
  "14": 1,
  "8": "Service Desk",
  ...extra,
});

describe("session and headers", () => {
  it("asks GLPI for raw (unsanitized) content and caches the session", async () => {
    const { fetch, calls } = legacyGlpi(() => undefined);
    const b = new LegacyBackend(cfg, fetch);
    expect(await b.whoami()).toEqual({
      user_id: 7,
      login: "jdoe",
      name: "Jane Doe",
      active_profile: undefined,
      active_entity: undefined,
      group_ids: [3, 4],
    });
    await b.session();
    expect(calls.filter((c) => c.url.pathname.endsWith("/getFullSession"))).toHaveLength(1);
    expect(calls[1].headers["x-glpi-sanitized-content"]).toBe("false");
  });

  it("uses a per-user token when given one", async () => {
    const { fetch, calls } = legacyGlpi(() => undefined);
    await new LegacyBackend(cfg, fetch, { userToken: "personal123" }).session();
    expect(calls[0].headers.authorization).toBe("user_token personal123");
  });
});

describe("myQueue", () => {
  it("searches open items assigned to me or my groups, by priority", async () => {
    const { fetch, calls } = legacyGlpi((c) =>
      c.url.pathname.endsWith("/search/Ticket") ? { body: { totalcount: 1, data: [ticketRow(10)] } } : undefined,
    );
    const page = await new LegacyBackend(cfg, fetch).myQueue({ itilType: "Ticket", includeGroups: true, start: 0, limit: 20 });
    const q = query(calls.find((c) => c.url.pathname.endsWith("/search/Ticket"))!);
    expect(q).toContain("criteria[0][criteria][0][value]=notold");
    expect(q).toContain("criteria[1][criteria][0][field]=5&criteria[1][criteria][0][searchtype]=equals&criteria[1][criteria][0][value]=7");
    expect(q).toContain("criteria[1][criteria][1][link]=OR&criteria[1][criteria][1][field]=8");
    expect(q).toContain("criteria[1][criteria][2][value]=4");
    expect(q).toContain("sort=3&order=DESC");
    expect(page.items[0]).toMatchObject({ id: 10, priority: "high", assigned_group: "Service Desk" });
  });
});

describe("slaAtRisk", () => {
  it("runs overdue and due-soon searches with GLPI relative dates and merges them", async () => {
    const { fetch, calls } = legacyGlpi((c) => {
      if (!c.url.pathname.endsWith("/search/Ticket")) return undefined;
      const q = query(c);
      const overdue = q.includes("[searchtype]=lessthan&criteria[1][value]=NOW");
      if (q.includes("[field]=18")) {
        return { body: { totalcount: 1, data: [ticketRow(overdue ? 1 : 2, { "18": overdue ? "2026-11-01 10:00:00" : "2026-11-09 12:00:00" })] } };
      }
      return { body: { totalcount: 0, data: [] } };
    });
    const r = await new LegacyBackend(cfg, fetch).slaAtRisk({ kinds: ["resolve", "own"], withinHours: 4, includeOla: false, limit: 10 });
    const searches = calls.filter((c) => c.url.pathname.endsWith("/search/Ticket")).map(query);
    expect(searches).toHaveLength(4); // 2 targets x (overdue, due soon)
    expect(searches.some((q) => q.includes("criteria[2][value]=4HOUR"))).toBe(true);
    expect(searches.some((q) => q.includes("[field]=155") && q.includes("criteria[0][criteria][0][value]=1"))).toBe(true);
    expect(r.overdue).toEqual([expect.objectContaining({ id: 1, target: "time_to_resolve", due: "2026-11-01 10:00:00", state: "overdue" })]);
    expect(r.due_soon).toEqual([expect.objectContaining({ id: 2, state: "due_soon" })]);
  });
});

describe("findSimilar", () => {
  it("searches KB, open and solved tickets with OR'ed keywords, ranks them and adds solutions", async () => {
    const { fetch, calls } = legacyGlpi((c) => {
      const p = c.url.pathname;
      if (p.endsWith("/search/KnowbaseItem")) {
        return { body: { totalcount: 1, data: [{ "6": "VPN error 809", "2": 31, "7": "<p>Open UDP 500 and 4500</p>" }] } };
      }
      if (p.endsWith("/search/Ticket")) {
        const solved = query(c).includes("criteria[0][criteria][0][value]=5");
        return {
          body: {
            totalcount: 1,
            data: [solved ? { "1": "VPN 809 at home", "2": 90, "12": 6, "21": "error 809" } : { "1": "Printer jam", "2": 91, "12": 1, "21": "vpn" }],
          },
        };
      }
      if (p.endsWith("/Ticket/90/ITILSolution")) return { body: [{ content: "&lt;p&gt;Router blocked IPsec&lt;/p&gt;" }] };
      return undefined;
    });
    const hits = await new LegacyBackend(cfg, fetch).findSimilar({
      text: "La VPN da error 809",
      includeKb: true,
      includeOpen: true,
      includeSolved: true,
      limit: 5,
    });
    const kbQuery = query(calls.find((c) => c.url.pathname.endsWith("/search/KnowbaseItem"))!);
    expect(kbQuery).toContain("[field]=6&");
    expect(kbQuery).toContain("[link]=OR&criteria[0][criteria][1][field]=7");
    // keywords: "vpn", "809" ("error" is too generic); title match 3, body match 1
    expect(hits.map((h) => [h.kind, h.id, h.score])).toEqual([
      ["solved_ticket", 90, 7],
      ["kb_article", 31, 6],
      ["open_ticket", 91, 1],
    ]);
    expect(hits[1].excerpt).toBe("Open UDP 500 and 4500");
    expect((hits[0] as any).solution).toBe("Router blocked IPsec");
  });

  it("refuses text without searchable words", async () => {
    const { fetch } = legacyGlpi(() => undefined);
    await expect(
      new LegacyBackend(cfg, fetch).findSimilar({ text: "hola ayuda", includeKb: true, includeOpen: true, includeSolved: true, limit: 5 }),
    ).rejects.toThrow(/no searchable words/);
  });
});

describe("documents", () => {
  it("lists attachments through with_documents", async () => {
    const { fetch, calls } = legacyGlpi((c) =>
      c.url.pathname.endsWith("/Ticket/5")
        ? { body: { id: 5, _documents: [{ id: 12, name: "Screenshot", filename: "s.png", mime: "image/png", assocdate: "2026-11-01" }] } }
        : undefined,
    );
    expect(await new LegacyBackend(cfg, fetch).listDocuments("Ticket", 5)).toEqual([
      { id: 12, name: "Screenshot", filename: "s.png", mime: "image/png", date: "2026-11-01" },
    ]);
    expect(calls.at(-1)!.url.searchParams.get("with_documents")).toBe("true");
  });

  it("downloads bytes with alt=media and enforces the size limit", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const { fetch, calls } = legacyGlpi((c) => {
      if (!c.url.pathname.endsWith("/Document/12")) return undefined;
      return c.url.searchParams.get("alt") === "media"
        ? { raw: png, headers: { "Content-Type": "application/octet-stream" } }
        : { body: { id: 12, filename: "s.png", mime: "image/png" } };
    });
    const b = new LegacyBackend(cfg, fetch);
    const doc = await b.downloadDocument(12, 1024);
    expect(doc).toMatchObject({ id: 12, filename: "s.png", mime: "image/png" });
    expect(doc.bytes.equals(png)).toBe(true);
    expect(calls.at(-1)!.headers.accept).toBe("application/octet-stream");
    await expect(b.downloadDocument(12, 3)).rejects.toThrow(/over the 3 byte limit/);
  });

  it("uploads a multipart document linked to the item", async () => {
    const { fetch, calls } = legacyGlpi((c) => (c.url.pathname.endsWith("/Document") ? { status: 201, body: { id: 99 } } : undefined));
    await new LegacyBackend(cfg, fetch).uploadDocument("Ticket", 5, "../../etc/log.txt", "text/plain", Buffer.from("hello"));
    const upload = calls.at(-1)!;
    expect(upload.method).toBe("POST");
    expect(upload.headers["content-type"]).toBeUndefined(); // set by fetch with the boundary
    const manifest = JSON.parse(await (upload.form!.get("uploadManifest") as Blob).text());
    expect(manifest).toEqual({ input: { name: ".._.._etc_log.txt", _filename: [".._.._etc_log.txt"], itemtype: "Ticket", items_id: 5 } });
    const file = upload.form!.get("filename[0]") as File;
    expect(await file.text()).toBe("hello");
  });
});

describe("approvals", () => {
  it("lists only my waiting approvals (exact match on top of GLPI's LIKE filter)", async () => {
    const { fetch, calls } = legacyGlpi((c) =>
      c.url.pathname.endsWith("/TicketValidation")
        ? {
            body: [
              { id: 1, tickets_id: 50, users_id_validate: 7, status: 2, comment_submission: "<p>New laptop</p>", _keys_names: { tickets_id: "Laptop for Ana", users_id: "ana" } },
              { id: 2, tickets_id: 51, users_id_validate: 17, status: 2 },
              { id: 3, tickets_id: 52, users_id_validate: 7, status: 3 },
            ],
          }
        : undefined,
    );
    const pending = await new LegacyBackend(cfg, fetch).listPendingValidations("Ticket", 10);
    expect(pending).toEqual([
      expect.objectContaining({ validation_id: 1, item_id: 50, item_name: "Laptop for Ana", status: "waiting", requested_by: "ana", comment_submission: "New laptop" }),
    ]);
    expect(query(calls.at(-1)!)).toContain("searchText[users_id_validate]=7&searchText[status]=2");
  });

  it("approves with status 3, requires a reason to refuse, and rejects problems", async () => {
    const { fetch, calls } = legacyGlpi((c) => (c.method === "PUT" ? { body: [{ 1: true }] } : undefined));
    const b = new LegacyBackend(cfg, fetch);
    await b.answerValidation("Change", 4, "approve", "ok");
    expect(calls.at(-1)!.url.pathname).toBe("/apirest.php/ChangeValidation/4");
    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ input: { status: 3, comment_validation: "ok" } });
    await expect(b.answerValidation("Ticket", 4, "refuse")).rejects.toThrow(/reason/);
    await expect(b.listValidations("Problem", 1)).rejects.toThrow(/only Ticket and Change/);
  });

  it("requests an approval from a user", async () => {
    const { fetch, calls } = legacyGlpi((c) => (c.method === "POST" ? { status: 201, body: { id: 8 } } : undefined));
    await new LegacyBackend(cfg, fetch).requestValidation("Ticket", 50, 12, "Please approve");
    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ input: { tickets_id: 50, users_id_validate: 12, comment_submission: "Please approve" } });
  });
});

describe("assetContext", () => {
  it("returns the asset summary and its ticket history, newest first", async () => {
    const { fetch, calls } = legacyGlpi((c) =>
      c.url.pathname.endsWith("/Computer/3")
        ? {
            body: {
              id: 3,
              name: "LAPTOP-07",
              serial: "SN1",
              users_id: "Ana",
              computermodels_id: "ThinkPad",
              comment: "",
              links: [],
              _tickets: [
                { id: 1, name: "Battery", status: 6, date: "2026-01-01 10:00:00" },
                { id: 2, name: "Battery again", status: 2, date: "2026-10-01 10:00:00" },
              ],
            },
          }
        : undefined,
    );
    const ctx = (await new LegacyBackend(cfg, fetch).assetContext("Computer", 3, 5)) as any;
    expect(calls.at(-1)!.url.searchParams.get("with_tickets")).toBe("true");
    expect(ctx.item).toEqual({ id: 3, name: "LAPTOP-07", serial: "SN1", users_id: "Ana", computermodels_id: "ThinkPad" });
    expect(ctx.tickets.total).toBe(2);
    expect(ctx.tickets.open).toBe(1);
    expect(ctx.tickets.recent[0]).toMatchObject({ id: 2, status: "processing (assigned)" });
  });
});

describe("itilStats", () => {
  it("filters by opening date and pages through results", async () => {
    let served = 0;
    const { fetch, calls } = legacyGlpi((c) => {
      if (!c.url.pathname.endsWith("/search/Ticket")) return undefined;
      const range = c.url.searchParams.get("range")!;
      const start = Number(range.split("-")[0]);
      const rows = Array.from({ length: start === 0 ? 500 : 100 }, () => ({ "2": ++served, "12": 5, "3": 3, "14": 1, "15": "2026-11-01 08:00:00", "17": "2026-11-01 09:00:00", "154": 3600 }));
      return { body: { totalcount: 600, data: rows } };
    });
    const s = (await new LegacyBackend(cfg, fetch).itilStats({ itilType: "Ticket", from: "2026-11-01", to: "2026-11-07", maxRows: 2000 })) as any;
    const searches = calls.filter((c) => c.url.pathname.endsWith("/search/Ticket"));
    expect(searches).toHaveLength(2);
    expect(query(searches[0])).toContain("criteria[0][searchtype]=morethan&criteria[0][value]=2026-10-31 23:59:59");
    expect(query(searches[0])).toContain("criteria[1][searchtype]=lessthan&criteria[1][value]=2026-11-07 23:59:59");
    expect(s.opened).toBe(600);
    expect(s.analyzed).toBe(600);
    expect(s.resolution_time.median).toBe("1h 0m");
  });
});

describe("search", () => {
  it("treats an out-of-range page as empty", async () => {
    const { fetch } = legacyGlpi(() => ({ status: 400, body: ["ERROR_RANGE_EXCEED_TOTAL", "out of range"] }));
    expect(await new LegacyBackend(cfg, fetch).search("Ticket", { display: [1], start: 100, limit: 10 })).toEqual({ total: 0, rows: [] });
  });

  it("searches users by login, first name or last name", async () => {
    const { fetch, calls } = legacyGlpi(() => ({ body: { totalcount: 1, data: [{ "1": "mgomez", "2": 12, "9": "Mario", "34": "Gómez", "5": "m@x.co" }] } }));
    const page = await new LegacyBackend(cfg, fetch).searchItems("User", "mario", 0, 10);
    expect(query(calls.at(-1)!)).toContain("criteria[1][link]=OR&criteria[1][field]=9");
    expect(page.items[0]).toEqual({ id: 12, name: "mgomez", fullname: "Mario Gómez", email: "m@x.co" });
  });
});
