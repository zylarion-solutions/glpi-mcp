/**
 * Picks the backend for the configured GLPI.
 *
 * GLPI_API_MODE=auto (default):
 *   - OAuth credentials present and GLPI lists High-Level API versions -> hlapi
 *   - otherwise legacy credentials present -> legacy
 * The choice is made on the first tool call, so the MCP server starts even if
 * GLPI is unreachable at that moment.
 *
 * Features the High-Level API lacks are retried on the legacy API when legacy
 * credentials are configured too (GLPI 11 ships both APIs).
 */
import { createHash } from "node:crypto";
import { ConfigError, hasLegacyCredentials, hasOAuthCredentials, type Config } from "../config.js";
import { GlpiApiError, type FetchLike } from "./http.js";
import { HlapiBackend } from "./hlapi.js";
import { LegacyBackend } from "./legacy.js";
import { UnsupportedFeatureError, type GlpiBackend } from "./types.js";

export async function createBackend(config: Config, fetchImpl: FetchLike = fetch): Promise<GlpiBackend> {
  const legacyOk = hasLegacyCredentials(config);
  const oauthOk = hasOAuthCredentials(config);

  if (config.apiMode === "legacy") {
    if (!legacyOk) throw new ConfigError("GLPI_API_MODE=legacy needs GLPI_USER_TOKEN, or GLPI_USERNAME and GLPI_PASSWORD");
    return new LegacyBackend(config, fetchImpl);
  }
  if (config.apiMode === "hlapi") {
    if (!oauthOk) {
      throw new ConfigError(
        "GLPI_API_MODE=hlapi needs GLPI_OAUTH_CLIENT_ID, GLPI_OAUTH_CLIENT_SECRET and a username/password",
      );
    }
    const hl = new HlapiBackend(config, fetchImpl);
    await hl.pinnedVersion();
    return hl;
  }

  // auto
  if (oauthOk) {
    const hl = new HlapiBackend(config, fetchImpl);
    try {
      await hl.pinnedVersion();
      return hl;
    } catch (err) {
      if (!legacyOk) {
        throw new Error(
          `OAuth credentials are set but the High-Level API is not available (${(err as Error).message}). ` +
            "It needs GLPI 11 or newer; for GLPI 9.5/10 set GLPI_USER_TOKEN (and GLPI_APP_TOKEN if required).",
        );
      }
    }
  }
  if (legacyOk) return new LegacyBackend(config, fetchImpl);
  throw new ConfigError(
    "No GLPI credentials configured. Set GLPI_USER_TOKEN (legacy API, GLPI 9.5-11) or " +
      "GLPI_OAUTH_CLIENT_ID/GLPI_OAUTH_CLIENT_SECRET/GLPI_USERNAME/GLPI_PASSWORD (High-Level API, GLPI 11+).",
  );
}

/** Where tools get their GLPI backend from. */
export interface BackendSource {
  /** "service_account" (configured credentials) or "user" (the caller's own GLPI token). */
  readonly identity: "service_account" | "user";
  get(): Promise<GlpiBackend>;
  /** Run on the primary backend and retry on the legacy API for features the High-Level API lacks. */
  run<T>(fn: (b: GlpiBackend) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Shared backend built from the configured (service account) credentials. */
export class BackendProvider implements BackendSource {
  readonly identity = "service_account" as const;
  private backend?: GlpiBackend;
  private pending?: Promise<GlpiBackend>;
  private legacyFallback?: LegacyBackend;

  constructor(
    private readonly config: Config,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async get(): Promise<GlpiBackend> {
    if (this.backend) return this.backend;
    this.pending ??= createBackend(this.config, this.fetchImpl)
      .then((b) => (this.backend = b))
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  async run<T>(fn: (b: GlpiBackend) => Promise<T>): Promise<T> {
    const primary = await this.get();
    try {
      return await fn(primary);
    } catch (err) {
      if (err instanceof UnsupportedFeatureError && primary.kind === "hlapi" && hasLegacyCredentials(this.config)) {
        this.legacyFallback ??= new LegacyBackend(this.config, this.fetchImpl);
        return fn(this.legacyFallback);
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    await Promise.all([this.backend?.close(), this.legacyFallback?.close()]);
    this.backend = undefined;
    this.legacyFallback = undefined;
  }
}

/** Backend acting as one GLPI user, through the legacy API and that user's personal API token. */
export class UserBackend implements BackendSource {
  readonly identity = "user" as const;
  constructor(
    private readonly backend: LegacyBackend,
    private readonly onRejected: () => void = () => {},
  ) {}
  async get(): Promise<GlpiBackend> {
    return this.backend;
  }
  async run<T>(fn: (b: GlpiBackend) => Promise<T>): Promise<T> {
    try {
      return await fn(this.backend);
    } catch (err) {
      // GLPI refused the token itself: forget it so it holds no slot in the pool.
      if (err instanceof GlpiApiError && err.path === "initSession") this.onRejected();
      throw err;
    }
  }
  async close(): Promise<void> {
    /* owned by the pool */
  }
}

/**
 * Keeps one GLPI session per user token, so each person acts with their own
 * GLPI rights. Idle sessions are closed after `idleMs`.
 */
export class UserBackendPool {
  private readonly entries = new Map<string, { backend: LegacyBackend; lastUsed: number }>();
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly config: Config,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly maxEntries = 500,
    private readonly idleMs = 30 * 60 * 1000,
  ) {
    this.timer = setInterval(() => void this.sweep(), Math.min(this.idleMs, 60_000));
    this.timer.unref();
  }

  forToken(userToken: string): UserBackend {
    const key = createHash("sha256").update(userToken).digest("hex");
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.maxEntries) void this.evictOldest();
      entry = { backend: new LegacyBackend(this.config, this.fetchImpl, { userToken }), lastUsed: Date.now() };
      this.entries.set(key, entry);
    }
    entry.lastUsed = Date.now();
    const current = entry;
    return new UserBackend(entry.backend, () => {
      if (this.entries.get(key) === current) this.entries.delete(key);
    });
  }

  get size(): number {
    return this.entries.size;
  }

  private async evictOldest() {
    let oldest: [string, { backend: LegacyBackend; lastUsed: number }] | undefined;
    for (const e of this.entries) if (!oldest || e[1].lastUsed < oldest[1].lastUsed) oldest = e;
    if (oldest) {
      this.entries.delete(oldest[0]);
      await oldest[1].backend.close();
    }
  }

  async sweep(now = Date.now()) {
    for (const [key, e] of this.entries) {
      if (now - e.lastUsed > this.idleMs) {
        this.entries.delete(key);
        await e.backend.close();
      }
    }
  }

  async close() {
    clearInterval(this.timer);
    await Promise.all([...this.entries.values()].map((e) => e.backend.close()));
    this.entries.clear();
  }
}
