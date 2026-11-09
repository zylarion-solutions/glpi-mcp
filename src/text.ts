/**
 * Turn GLPI rich text (HTML, sometimes entity-encoded twice) into compact
 * Markdown-ish plain text. Smaller and easier for a model to read than HTML.
 *
 * This is a formatter for display to an MCP client, not an HTML sanitizer:
 * the output is plain text and is never rendered as HTML.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
  hellip: "…",
  ndash: "–",
  mdash: "—",
  laquo: "«",
  raquo: "»",
  euro: "€",
  copy: "©",
  reg: "®",
  deg: "°",
  aacute: "á",
  eacute: "é",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  Aacute: "Á",
  Eacute: "É",
  Iacute: "Í",
  Oacute: "Ó",
  Uacute: "Ú",
  ntilde: "ñ",
  Ntilde: "Ñ",
  uuml: "ü",
  Uuml: "Ü",
  ccedil: "ç",
  Ccedil: "Ç",
  agrave: "à",
  egrave: "è",
  ograve: "ò",
  ecirc: "ê",
  ocirc: "ô",
  acirc: "â",
  iexcl: "¡",
  iquest: "¿",
};

/** Decode HTML entities once. */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match;
    }
    return NAMED_ENTITIES[code] ?? NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

/**
 * Remove HTML tags so a value reads as plain text.
 * A single pass can rebuild a tag from its pieces ("<scr<b>ipt>" -> "<script>"),
 * so strip until nothing changes and then drop any stray angle brackets.
 */
export function stripTags(input: string): string {
  let text = input;
  let previous: string;
  do {
    previous = text;
    text = text.replace(/<[^<>]*>/g, "");
  } while (text !== previous);
  return text.replace(/[<>]/g, "");
}

function replaceUntilStable(input: string, pattern: RegExp): string {
  let text = input;
  let previous: string;
  do {
    previous = text;
    text = text.replace(pattern, "");
  } while (text !== previous);
  return text;
}

/** Keep only web, mail and relative links; drop javascript:, data:, vbscript: and the like. */
export function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  const value = decodeEntities(href).trim();
  const scheme = value.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  if (scheme === undefined) return value.startsWith("//") ? undefined : value;
  return ["http", "https", "mailto"].includes(scheme) ? value : undefined;
}

/** Value of one attribute of an HTML tag (fixed pattern; the name is compared, not compiled). */
function attr(tag: string, name: string): string | undefined {
  for (const m of tag.matchAll(/\s([a-z][a-z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    if (m[1].toLowerCase() === name) return m[2] ?? m[3] ?? m[4];
  }
  return undefined;
}

/** Convert GLPI HTML to readable text, keeping links, lists, line breaks and image references. */
export function htmlToText(input: unknown): string {
  if (input === null || input === undefined) return "";
  let html = String(input);
  // GLPI may return entity-encoded HTML (sanitized content), sometimes twice.
  for (let i = 0; i < 3 && /&lt;\/?[a-z]/i.test(html); i++) html = decodeEntities(html);
  if (!/<[a-z!/]/i.test(html)) return tidy(decodeEntities(html));

  // Drop non-content blocks; repeat because removing one can join the pieces of another.
  html = replaceUntilStable(html, /<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi);
  html = replaceUntilStable(html, /<!--[\s\S]*?-->/g);

  let text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|blockquote|pre|table|ul|ol)>/gi, "\n\n")
    .replace(/<(p|div|tr|blockquote|pre|table)\b[^>]*>/gi, "\n")
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, level: string) => `\n\n${"#".repeat(Number(level))} `)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "")
    .replace(/<\/t[dh]>\s*/gi, " | ")
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "_$2_")
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, (tag: string, label: string) => {
      const href = safeHref(attr(tag, "href"));
      const clean = stripTags(label).trim();
      if (!href) return clean;
      return clean && clean !== href ? `${clean} (${href})` : href;
    })
    .replace(/<img\b[^>]*>/gi, (tag: string) => {
      const alt = attr(tag, "alt");
      const src = attr(tag, "src") ?? "";
      const doc = src.match(/docid=(\d+)/i)?.[1];
      return ` [image${alt ? `: ${alt}` : ""}${doc ? ` (document ${doc})` : ""}] `;
    });

  text = decodeEntities(stripTags(text));
  return tidy(text);
}

function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Trim long text for list views. */
export function excerpt(text: string, max = 280): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Fields that hold rich text in GLPI items. */
export const RICH_TEXT_FIELDS = ["content", "answer", "comment", "comment_submission", "comment_validation"];

/** Return a copy of a GLPI record with its rich-text fields converted to text. */
export function textifyRecord<T>(record: T): T {
  if (!record || typeof record !== "object" || Array.isArray(record)) return record;
  const out: Record<string, unknown> = { ...(record as Record<string, unknown>) };
  for (const key of RICH_TEXT_FIELDS) {
    if (typeof out[key] === "string") out[key] = htmlToText(out[key]);
  }
  return out as T;
}
