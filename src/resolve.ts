/**
 * Accept names wherever a GLPI ID is expected ("Mario", "Hardware > Laptops",
 * "Service Desk"). One clear match is used; several matches produce an error
 * listing the candidates so the assistant can ask the user which one.
 */
import { fold } from "./glpi/similar.js";
import type { GlpiBackend, ItemRef } from "./glpi/types.js";

export type Ref = number | string;

export class AmbiguousReferenceError extends Error {
  constructor(
    readonly itemtype: string,
    readonly query: string,
    readonly candidates: ItemRef[],
  ) {
    super(
      `"${query}" matches several ${itemtype} items. Ask the user which one and pass its id: ` +
        candidates
          .map((c) => `${c.id} = ${[c.name, c.fullname, c.email].filter(Boolean).join(" / ")}`)
          .join("; "),
    );
  }
}

function labels(c: ItemRef): string[] {
  const out = [c.name, c.fullname, c.email].filter((v): v is string => typeof v === "string" && v !== "");
  // Tree dropdowns come back as "Parent > Child": the leaf alone also counts as an exact name.
  if (typeof c.name === "string" && c.name.includes(">")) out.push(c.name.split(">").pop()!.trim());
  return out.map(fold);
}

export async function resolveRef(
  backend: GlpiBackend,
  itemtype: string,
  value: Ref | undefined,
): Promise<number | undefined> {
  if (value === undefined) return undefined;
  if (typeof value === "number") return value;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text);
  if (/^(me|myself|yo|moi|eu)$/i.test(text) && itemtype === "User") return (await backend.session()).userId;

  const page = await backend.searchItems(itemtype, text, 0, 15);
  const found = page.items.filter((i) => Number.isFinite(i.id) && i.id > 0);
  if (!found.length) {
    throw new Error(`No ${itemtype} matches "${text}". Check the spelling or look it up with glpi_search_items.`);
  }
  if (found.length === 1) return found[0].id;
  const wanted = fold(text);
  const exact = found.filter((c) => labels(c).includes(wanted));
  if (exact.length === 1) return exact[0].id;
  throw new AmbiguousReferenceError(itemtype, text, (exact.length ? exact : found).slice(0, 10));
}

/** Resolve several references at once; undefined values stay undefined. */
export async function resolveAll<K extends string>(
  backend: GlpiBackend,
  refs: Record<K, [itemtype: string, value: Ref | undefined]>,
): Promise<Record<K, number | undefined>> {
  const out = {} as Record<K, number | undefined>;
  for (const key of Object.keys(refs) as K[]) {
    const [itemtype, value] = refs[key];
    out[key] = await resolveRef(backend, itemtype, value);
  }
  return out;
}
