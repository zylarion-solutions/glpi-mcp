import { describe, expect, it } from "vitest";
import { keywords, scoreText } from "../src/glpi/similar.js";
import { computeItilStats, humanDuration, secondsBetween, type StatsRow } from "../src/glpi/stats.js";

describe("keywords", () => {
  it("drops stop words in several languages, folds accents and keeps the longest words", () => {
    expect(keywords("Hola, la impresora del piso 3 no imprime desde ayer, ayuda por favor")).toEqual([
      "impresora",
      "imprime",
      "desde",
      "piso",
      "ayer",
    ]);
    expect(keywords("The VPN client shows error 809 when connecting")).toEqual(["connecting", "client", "shows", "vpn", "809"]);
    expect(keywords("Café débil")).toEqual(["debil", "cafe"]);
  });

  it("returns nothing for empty or stop-word-only text", () => {
    expect(keywords("hola por favor ayuda")).toEqual([]);
  });
});

describe("scoreText", () => {
  it("weighs title matches over body matches", () => {
    expect(scoreText(["vpn", "809"], "VPN caída", "error 809 al conectar")).toBe(3 + 1);
    expect(scoreText(["vpn"], "Impresora", "nada")).toBe(0);
  });
});

describe("stats", () => {
  it("measures durations between GLPI datetimes", () => {
    expect(secondsBetween("2026-11-01 08:00:00", "2026-11-01 10:30:00")).toBe(9000);
    expect(secondsBetween("2026-11-02 08:00:00", "2026-11-01 08:00:00")).toBeUndefined();
    expect(humanDuration(9000)).toBe("2h 30m");
    expect(humanDuration(90000)).toBe("1d 1h");
  });

  it("computes volume, resolution time and SLA compliance", () => {
    const rows: StatsRow[] = [
      { status: 5, priority: 4, type: 1, category: "Network", group: "Service Desk", date: "2026-11-01 08:00:00", solveDate: "2026-11-01 10:00:00", timeToResolve: "2026-11-01 12:00:00", solveDelay: 7200, takeIntoAccountDelay: 600 },
      { status: 6, priority: 3, type: 2, category: "Network", group: "Service Desk", date: "2026-11-01 09:00:00", solveDate: "2026-11-02 09:00:00", timeToResolve: "2026-11-01 17:00:00", takeIntoAccountDelay: 1200 },
      { status: 2, priority: 3, type: 1, category: "Hardware", date: "2026-11-02 09:00:00", timeToResolve: "2026-11-03 09:00:00" },
    ];
    const s = computeItilStats({ itilType: "Ticket", from: "2026-11-01", to: "2026-11-02", maxRows: 100 }, rows, 3) as any;
    expect(s.opened).toBe(3);
    expect(s.solved_or_closed).toBe(2);
    expect(s.still_open).toBe(1);
    expect(s.by_type).toEqual({ incident: 2, request: 1 });
    expect(s.top_categories).toEqual({ Network: 2, Hardware: 1 });
    expect(s.resolution_time.count).toBe(2);
    expect(s.resolution_time.median_seconds).toBe(86400); // GLPI delay for #1 (7200), calendar time for #2 (86400)
    expect(s.time_to_own.mean).toBe("15m");
    expect(s.sla_time_to_resolve).toEqual({ solved_with_target: 2, met: 1, breached: 1, compliance_percent: 50 });
    expect(s.truncated).toBeUndefined();
  });

  it("says when rows were capped", () => {
    const s = computeItilStats({ itilType: "Change", from: "2026-11-01", to: "2026-11-02", maxRows: 1 }, [{ status: 1, priority: 3 }], 40) as any;
    expect(s.truncated).toMatch(/first 1 of 40/);
    expect(s.by_type).toBeUndefined();
  });
});
