/** Minimal HTTP helper on top of fetch, with timeouts and readable GLPI errors. */

export class GlpiApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: unknown,
  ) {
    super(`GLPI ${method} ${path} returned HTTP ${status}: ${describeBody(body)}`);
  }
}

export class GlpiPermissionError extends Error {}

/** GLPI legacy errors come as ["ERROR_CODE", "message"]; HLAPI as {title, detail}. */
export function describeBody(body: unknown): string {
  if (body == null || body === "") return "(empty body)";
  if (Array.isArray(body)) return body.map(String).join(" - ");
  if (typeof body === "object") {
    const b = body as Record<string, unknown>;
    const parts = [b.title, b.detail, b.error, b.error_description, b.message].filter(Boolean);
    if (parts.length) return parts.map(String).join(" - ");
    return JSON.stringify(body).slice(0, 500);
  }
  return String(body).slice(0, 500);
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
}

export type FetchLike = typeof fetch;

export async function httpRequest<T = unknown>(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit & { timeoutMs: number; binary?: boolean; maxBytes?: number },
): Promise<HttpResponse<T>> {
  const { timeoutMs, binary, maxBytes, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetchImpl(url, { ...rest, signal: controller.signal, redirect: "manual" });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new Error(`GLPI did not answer within ${timeoutMs} ms (${init.method ?? "GET"} ${redactUrl(url)})`);
      }
      throw new Error(`Could not reach GLPI at ${redactUrl(url)}: ${(err as Error).message}`);
    }
    if (binary && res.status < 400) {
      const declared = Number(res.headers.get("content-length") ?? NaN);
      if (maxBytes !== undefined && Number.isFinite(declared) && declared > maxBytes) {
        controller.abort();
        throw new Error(`File is ${declared} bytes, over the ${maxBytes} byte limit`);
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      if (maxBytes !== undefined && bytes.length > maxBytes) {
        throw new Error(`File is ${bytes.length} bytes, over the ${maxBytes} byte limit`);
      }
      return { status: res.status, headers: res.headers, body: bytes as T };
    }
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: res.status, headers: res.headers, body: body as T };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`GLPI did not answer within ${timeoutMs} ms (${init.method ?? "GET"} ${redactUrl(url)})`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Never print tokens that might be in a query string. */
export function redactUrl(url: string): string {
  return url.replace(/(app_token|user_token|session_token|access_token)=[^&]+/gi, "$1=***");
}

/**
 * Serialize nested params the way PHP expects them:
 * {criteria: [{field: 1}]} -> criteria[0][field]=1
 */
export function toPhpQuery(params: Record<string, unknown>): string {
  const out: string[] = [];
  const walk = (value: unknown, key: string) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${key}[${i}]`));
    } else if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, `${key}[${k}]`);
    } else {
      out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  };
  for (const [k, v] of Object.entries(params)) walk(v, k);
  return out.join("&");
}

/** Read the total from a "Content-Range: 0-19/245" header. */
export function totalFromContentRange(headers: Headers): number | undefined {
  const value = headers.get("content-range");
  const match = value?.match(/\/(\d+)\s*$/);
  return match ? Number(match[1]) : undefined;
}
