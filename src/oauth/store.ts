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
import { readFileSync, renameSync, writeFileSync } from "node:fs";
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
}

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

export class OAuthStore {
  readonly clients = new Map<string, OAuthClientInformationFull>();
  readonly codes = new Map<string, AuthCode>();
  readonly grants = new Map<string, Grant>();
  readonly access = new Map<string, TokenRecord>();
  readonly refresh = new Map<string, TokenRecord>();
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
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAuthTag(tag);
      snap = JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8")) as Snapshot;
    } catch {
      throw new Error("Cannot read MCP_OAUTH_STATE_FILE: wrong MCP_OAUTH_SECRET or corrupted file");
    }
    for (const [k, v] of Object.entries(snap.clients ?? {})) this.clients.set(k, v);
    for (const [k, v] of Object.entries(snap.grants ?? {})) this.grants.set(k, v);
    for (const [k, v] of Object.entries(snap.access ?? {})) this.access.set(k, v);
    for (const [k, v] of Object.entries(snap.refresh ?? {})) this.refresh.set(k, v);
    this.sweep();
  }

  /** Persist soon (coalesces bursts of changes). */
  changed() {
    if (!this.file) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 200);
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
    };
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(snap), "utf8"), cipher.final()]);
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, Buffer.concat([iv, cipher.getAuthTag(), data]), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  // ---------------------------------------------------------------- cleanup

  /** Drop expired codes and tokens, and grants no refresh token points to any more. */
  sweep(now = Date.now()) {
    let dirty = false;
    for (const [k, v] of this.codes) if (v.expiresAt <= now) this.codes.delete(k);
    for (const map of [this.access, this.refresh]) {
      for (const [k, v] of map) {
        if (v.expiresAt <= now) {
          map.delete(k);
          dirty = true;
        }
      }
    }
    const live = new Set([...this.refresh.values()].map((r) => r.grantId));
    for (const [k, g] of this.grants) {
      if (!live.has(k) && ![...this.access.values()].some((a) => a.grantId === k)) {
        this.grants.delete(k);
        dirty = true;
      }
      void g;
    }
    if (dirty) this.changed();
  }

  /** Remove a grant and every token issued from it. */
  revokeGrant(grantId: string) {
    this.grants.delete(grantId);
    for (const map of [this.access, this.refresh]) {
      for (const [k, v] of map) if (v.grantId === grantId) map.delete(k);
    }
    this.changed();
  }
}
