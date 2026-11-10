/**
 * Service desk metrics computed from raw GLPI search rows.
 * Kept free of I/O so it can be tested and reused by any backend.
 */
import { PRIORITY_LABELS, STATUS_LABELS, TICKET_TYPE_LABELS, type StatsQuery } from "./types.js";

export interface StatsRow {
  status: number;
  priority: number;
  type?: number;
  category?: string;
  group?: string;
  /** "YYYY-MM-DD HH:MM:SS", GLPI server time. */
  date?: string;
  solveDate?: string;
  timeToResolve?: string;
  timeToOwn?: string;
  /** Seconds, as computed by GLPI (business hours when a calendar applies). */
  solveDelay?: number;
  takeIntoAccountDelay?: number;
}

/** Seconds between two GLPI datetimes (same server time zone, so the offset cancels out). */
export function secondsBetween(from?: string, to?: string): number | undefined {
  if (!from || !to) return undefined;
  const a = Date.parse(`${from.replace(" ", "T")}Z`);
  const b = Date.parse(`${to.replace(" ", "T")}Z`);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? (b - a) / 1000 : undefined;
}

export function humanDuration(seconds: number | undefined): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds)) return undefined;
  const s = Math.round(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function summarize(values: number[]) {
  if (!values.length) return { count: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1) + 0.5))];
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  return {
    count: sorted.length,
    mean: humanDuration(mean),
    median: humanDuration(at(0.5)),
    p90: humanDuration(at(0.9)),
    mean_seconds: Math.round(mean),
    median_seconds: Math.round(at(0.5)),
  };
}

function countBy(rows: StatsRow[], key: (r: StatsRow) => string | undefined, top?: number) {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = key(r) ?? "(none)";
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(top ? entries.slice(0, top) : entries);
}

export function computeItilStats(q: StatsQuery, rows: StatsRow[], total: number) {
  const solved = rows.filter((r) => r.status === 5 || r.status === 6);
  const open = rows.filter((r) => r.status !== 5 && r.status !== 6);

  const resolution = solved
    .map((r) => (r.solveDelay && r.solveDelay > 0 ? r.solveDelay : secondsBetween(r.date, r.solveDate)))
    .filter((v): v is number => v !== undefined);
  const ownTimes = rows
    .map((r) => r.takeIntoAccountDelay)
    .filter((v): v is number => v !== undefined && v > 0);

  const withTtr = solved.filter((r) => r.timeToResolve && r.solveDate);
  const ttrMet = withTtr.filter((r) => (r.solveDate as string) <= (r.timeToResolve as string)).length;

  return {
    itil_type: q.itilType,
    period: { from: q.from, to: q.to, by: "opening date" },
    filters: { assigned_group_id: q.assignedGroupId, category_id: q.categoryId },
    opened: total,
    analyzed: rows.length,
    truncated: total > rows.length ? `Only the first ${rows.length} of ${total} items were analyzed (max_rows).` : undefined,
    solved_or_closed: solved.length,
    still_open: open.length,
    by_status: countBy(rows, (r) => STATUS_LABELS[r.status]),
    by_priority: countBy(rows, (r) => PRIORITY_LABELS[r.priority]),
    ...(q.itilType === "Ticket" ? { by_type: countBy(rows, (r) => (r.type ? TICKET_TYPE_LABELS[r.type] : undefined)) } : {}),
    top_categories: countBy(rows, (r) => r.category, 10),
    top_assigned_groups: countBy(rows, (r) => r.group, 10),
    resolution_time: summarize(resolution),
    ...(q.itilType === "Ticket" ? { time_to_own: summarize(ownTimes) } : {}),
    sla_time_to_resolve: withTtr.length
      ? {
          solved_with_target: withTtr.length,
          met: ttrMet,
          breached: withTtr.length - ttrMet,
          compliance_percent: Math.round((ttrMet / withTtr.length) * 1000) / 10,
        }
      : { solved_with_target: 0, note: "No solved items with a time-to-resolve target in this period" },
    notes: [
      "Resolution time uses GLPI's own resolution delay when available (business hours if a calendar applies), otherwise opening-to-solution calendar time.",
      "Dates are in the GLPI server time zone.",
    ],
  };
}
