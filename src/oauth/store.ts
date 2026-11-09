/**
 * State of the OAuth server: registered clients, authorization codes, and the
 * grants that link a client to one GLPI user's API token.
 *
 * - Access and refresh tokens are stored by SHA-256 hash, never in clear.
 * - The optional state file is encrypted with AES-256-GCM (key derived from
 *   MCP_OAUTH_SECRET), so the GLPI tokens inside it are not readable on disk.
 * - Without a state file everything lives in memory: users log in again after
 *   a restart.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

export interface Grant {
  clientId: string;
  glpiUserToken: string;
  userId: number;
  login?: string;
  scopes: string[];
  resource?: string;
  createdAt: number;
}

export interface AuthCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  grant: Omit<Grant, "createdAt">;
  expiresAt: number;
  /** Set when a token request checked this code's PKCE challenge. */
  challenged?: boolean;
}

export interface TokenRecord {
  grantId: string;
  clientId: string;
  expiresAt: number;
}

interface Snapshot {
  version: 1;
  clients: Record<string, OAuthClientInformationFull>;
  grants: Record<string, Grant>;
  access: Record<string, TokenRecord>;
  refresh: Record<string, TokenRecord>;
  rotated?: Record<string, TokenRecord>;
}

/** Registered clients that never completed a sign-in are forgotten after this long. */
const UNUSED_CLIENT_TTL_MS = 7 * 24 * 3600 * 1000;

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

export class OAuthStore {
  readonly clients = new Map<string, OAuthClientInformationFull>();
  readonly codes = new Map<string, AuthCode>();
  readonly grants = new Map<string, Grant>();
  readonly access = new Map<string, TokenRecord>();
  readonly refresh = new Map<string, TokenRecord>();
  /** Refresh tokens already rotated, kept until they would have expired, to detect reuse. */
  readonly rotated = new Map<string, TokenRecord>();
  private readonly key?: Buffer;
  private saveTimer?: NodeJS.Timeout;

  constructor(
    secret: string,
    private readonly file?: string,
  ) {
    if (file) {
      this.key = scryptSync(secret, "glpi-mcp-oauth-state", 32);
      this.load();
    }
  }

  // ------------------------------------------------------------ persistence

  private load() {
    if (!this.file || !this.key) return;
    let raw: Buffer;
    try {
      raw = readFileSync(this.file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const data = raw.subarray(28);
    let snap: Snapshot;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv, { authTagLength: 16 });
      decipher.setAuthTag(tag);
      snap = JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8")) as Snapshot;
    } catch {
      throw new Error("Cannot read MCP_OAUTH_STATE_FILE: wrong MCP_OAUTH_SECRET or corrupted file");
    }
    for (const [k, v] of Object.entries(snap.clients ?? {})) this.clients.set(k, v);
    for (const [k, v] of Object.entries(snap.grants ?? {})) this.grants.set(k, v);
    for (const [k, v] of Object.entries(snap.access ?? {})) this.access.set(k, v);
    for (const [k, v] of Object.entries(snap.refresh ?? {})) this.refresh.set(k, v);
    for (const [k, v] of Object.entries(snap.rotated ?? {})) this.rotated.set(k, v);
    this.sweep();
  }

  /** Persist soon (coalesces bursts of changes). */
  changed() {
    if (!this.file) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        this.saveNow();
      } catch (err) {
        // Never crash the server over persistence; sign-ins still work from memory.
        console.error("[glpi-mcp] could not save MCP_OAUTH_STATE_FILE:", (err as Error).message);
      }
    }, 200);
    this.saveTimer.unref();
  }

  saveNow() {
    if (!this.file || !this.key) return;
    clearTimeout(this.saveTimer);
    const snap: Snapshot = {
      version: 1,
      clients: Object.fromEntries(this.clients),
      grants: Object.fromEntries(this.grants),
      access: Object.fromEntries(this.access),
      refresh: Object.fromEntries(this.refresh),
      rotated: Object.fromEntries(this.rotated),
    };
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv, { authTagLength: 16 });
    const data = Buffer.concat([cipher.update(JSON.stringify(snap), "utf8"), cipher.final()]);
    const tmp = `${this.file}.tmp`;
    // Recreate the temp file so it always gets 0600, and flush it before the atomic rename.
    rmSync(tmp, { force: true });
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, Buffer.concat([iv, cipher.getAuthTag(), data]));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.file);
  }

  // ---------------------------------------------------------------- cleanup

  /** Drop expired codes and tokens, grants nothing points to any more, and clients never used. */
  sweep(now = Date.now()) {
    let dirty = false;
    for (const [k, v] of this.codes) if (v.expiresAt <= now) this.codes.delete(k);
    for (const map of [this.access, this.refresh, this.rotated]) {
      for (const [k, v] of map) {
        if (v.expiresAt <= now) {
          map.delete(k);
          dirty = true;
        }
      }
    }
    const live = new Set<string>();
    for (const r of this.refresh.values()) live.add(r.grantId);
    for (const a of this.access.values()) live.add(a.grantId);
    for (const k of this.grants.keys()) {
      if (!live.has(k)) {
        this.grants.delete(k);
        dirty = true;
      }
    }
    const used = new Set<string>();
    for (const g of this.grants.values()) used.add(g.clientId);
    for (const c of this.codes.values()) used.add(c.clientId);
    for (const [id, c] of this.clients) {
      const issued = (c.client_id_issued_at ?? 0) * 1000;
      if (!used.has(id) && issued + UNUSED_CLIENT_TTL_MS <= now) {
        this.clients.delete(id);
        dirty = true;
      }
    }
    if (dirty) this.changed();
  }

  /** Remove a grant and every token issued from it. */
  revokeGrant(grantId: string) {
    this.grants.delete(grantId);
    for (const map of [this.access, this.refresh, this.rotated]) {
      for (const [k, v] of map) if (v.grantId === grantId) map.delete(k);
    }
    this.changed();
  }
}
