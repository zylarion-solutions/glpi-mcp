import { loadConfig, type Config } from "../src/config.js";
import type { FetchLike } from "../src/glpi/http.js";

export interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: string;
  form?: FormData;
}

export type MockResponse = { status?: number; body?: unknown; raw?: Buffer; headers?: Record<string, string> } | undefined;
type Handler = (call: Call) => MockResponse;

/** A fake fetch that records calls and answers from a handler. */
export function mockFetch(handler: Handler): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const call: Call = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
      form: init?.body instanceof FormData ? init.body : undefined,
    };
    calls.push(call);
    const r = handler(call) ?? { status: 404, body: ["ERROR_NOT_FOUND", "no mock"] };
    if (r.raw) {
      return new Response(new Uint8Array(r.raw), { status: r.status ?? 200, headers: r.headers ?? {} });
    }
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "Content-Type": "application/json", ...(r.headers ?? {}) },
    });
  }) as FetchLike;
  return { fetch: fetchImpl, calls };
}

export function config(env: Record<string, string> = {}): Config {
  return loadConfig({ GLPI_URL: "https://glpi.test", ...env });
}

/** Decoded query string, for readable assertions on PHP-style criteria. */
export function query(call: Call): string {
  return decodeURIComponent(call.url.search);
}

/** Minimal legacy GLPI: session endpoints plus a route table. */
export function legacyGlpi(
  routes: (call: Call) => MockResponse,
  session: Record<string, unknown> = { glpiID: 7, glpiname: "jdoe", glpifirstname: "Jane", glpirealname: "Doe", glpigroups: [3, 4] },
) {
  return mockFetch((c) => {
    if (c.url.pathname.endsWith("/initSession")) return { body: { session_token: "st" } };
    if (c.url.pathname.endsWith("/killSession")) return { body: {} };
    if (c.url.pathname.endsWith("/getFullSession")) return { body: { session } };
    return routes(c);
  });
}
