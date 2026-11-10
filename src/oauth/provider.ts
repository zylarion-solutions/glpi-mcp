/**
 * OAuth 2.1 authorization server for the HTTP transport (MCP_AUTH_MODE=oauth),
 * so the server can be added as a custom connector in claude.ai and each person
 * acts in GLPI as themselves.
 *
 * Flow: the client registers itself (dynamic client registration), sends the
 * user to /authorize, the user signs in with their personal GLPI API token
 * (GLPI > My settings > Remote access keys), and the client receives an access
 * token bound to that GLPI identity. PKCE is enforced by the SDK.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import type { Response } from "express";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { redirectUriMatches } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { hashToken, randomToken, type Grant, type OAuthStore } from "./store.js";
import { renderLoginPage } from "./page.js";

export const OAUTH_SCOPE = "glpi";
const CODE_TTL_MS = 5 * 60 * 1000;
const LOGIN_FORM_TTL_MS = 15 * 60 * 1000;
/** Active connections one GLPI user may have; the oldest is signed out beyond this. */
export const MAX_GRANTS_PER_USER = 10;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export interface GlpiIdentity {
  userId: number;
  login?: string;
  name?: string;
}

/** Checks a personal GLPI API token and returns who it belongs to. */
export type TokenValidator = (glpiUserToken: string) => Promise<GlpiIdentity>;

interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource?: string;
  exp: number;
}

export interface ProviderOptions {
  secret: string;
  glpiUrl: string;
  accessTokenTtl: number;
  refreshTokenTtl: number;
  /** A sign-in stays usable at most this long, however often it is refreshed (seconds). */
  maxGrantAge: number;
  /** Hosts allowed in redirect URIs ("*" allows any); loopback is always allowed for local apps. */
  redirectHosts: string[];
  /** This server's MCP endpoint: the only resource tokens are issued for. */
  resourceUrl: string;
  validateToken: TokenValidator;
}

const comparable = (u: string) => u.split("#")[0].replace(/\/$/, "");

export class GlpiOAuthProvider implements OAuthServerProvider {
  /** Key that seals the login form: the browser can neither read nor change the request it carries. */
  private readonly formKey: Buffer;

  constructor(
    private readonly store: OAuthStore,
    private readonly opts: ProviderOptions,
  ) {
    this.formKey = scryptSync(opts.secret, "glpi-mcp-login-form", 32);
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => this.store.clients.get(clientId),
      registerClient: (client) => {
        const full = client as OAuthClientInformationFull;
        if (!full.client_id) throw new Error("client_id generation is required");
        const refused = full.redirect_uris.filter((u) => !this.redirectAllowed(u));
        if (refused.length) {
          throw new InvalidClientMetadataError(
            `redirect_uri host not allowed on this server: ${refused.join(", ")} (see MCP_OAUTH_REDIRECT_HOSTS)`,
          );
        }
        this.store.clients.set(full.client_id, full);
        this.store.changed();
        return full;
      },
    };
  }

  /** Only known apps (claude.ai by default) and local apps may receive authorization codes. */
  redirectAllowed(uri: string): boolean {
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      return false;
    }
    if (LOOPBACK.has(url.hostname)) return url.protocol === "http:" || url.protocol === "https:";
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return this.opts.redirectHosts.some((h) => h === "*" || host === h || host.endsWith(`.${h}`));
  }

  // ------------------------------------------------------------ login form

  /** Encrypt and authenticate the authorization request into one form field (AES-256-GCM). */
  sealRequest(p: PendingAuthorization): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.formKey, iv, { authTagLength: 16 });
    const data = Buffer.concat([cipher.update(JSON.stringify(p), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
  }

  openRequest(sealed: string): PendingAuthorization {
    let p: PendingAuthorization;
    try {
      const raw = Buffer.from(String(sealed), "base64url");
      if (raw.length < 29) throw new Error("short");
      const decipher = createDecipheriv("aes-256-gcm", this.formKey, raw.subarray(0, 12), { authTagLength: 16 });
      decipher.setAuthTag(raw.subarray(12, 28));
      p = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8"));
    } catch {
      throw new Error("Invalid login request");
    }
    if (p.exp < Date.now()) throw new Error("The sign-in page expired. Start the connection again from your app.");
    return p;
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    // Clients registered before the allow-list changed are re-checked here.
    if (!this.redirectAllowed(params.redirectUri)) throw new InvalidRequestError("redirect_uri host not allowed on this server");
    if (params.resource && comparable(params.resource.toString()) !== comparable(this.opts.resourceUrl)) {
      throw new InvalidRequestError("Tokens can only be issued for this server's MCP endpoint");
    }
    const pending: PendingAuthorization = {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes?.length ? params.scopes : [OAUTH_SCOPE],
      resource: params.resource?.toString(),
      exp: Date.now() + LOGIN_FORM_TTL_MS,
    };
    this.sendLoginPage(res, this.sealRequest(pending), pending.redirectUri, client.client_name);
  }

  sendLoginPage(res: Response, sealed: string, redirectUri: string, clientName?: string, error?: string, status = 200) {
    const target = new URL(redirectUri);
    // The form posts here and is then redirected to the app: CSP form-action must allow both.
    res
      .status(status)
      .set({
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${target.origin}; frame-ancestors 'none'; base-uri 'none'`,
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
      })
      .send(renderLoginPage({ sealed, clientName, redirectHost: target.host, glpiUrl: this.opts.glpiUrl, error }));
  }

  /**
   * Handle the submitted login form. Returns the URL to redirect the browser to,
   * or throws a user-facing error (the caller re-renders the form).
   */
  async completeLogin(sealed: string, glpiUserToken: string): Promise<string> {
    const p = this.openRequest(sealed);
    const client = this.store.clients.get(p.clientId);
    if (!client || !client.redirect_uris.some((r) => redirectUriMatches(p.redirectUri, r)) || !this.redirectAllowed(p.redirectUri)) {
      throw new Error("Unknown application. Start again from your app.");
    }
    const token = glpiUserToken.trim();
    if (!/^[A-Za-z0-9]{20,128}$/.test(token)) throw new Error("That does not look like a GLPI API token (letters and digits only).");

    let who: GlpiIdentity;
    try {
      who = await this.opts.validateToken(token);
    } catch {
      throw new Error("GLPI did not accept this token. Check it in GLPI (My settings > Remote access keys) and try again.");
    }

    const code = randomToken();
    this.store.codes.set(hashToken(code), {
      clientId: p.clientId,
      redirectUri: p.redirectUri,
      codeChallenge: p.codeChallenge,
      grant: {
        clientId: p.clientId,
        glpiUserToken: token,
        userId: who.userId,
        login: who.login,
        scopes: p.scopes,
        resource: p.resource,
      },
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    const target = new URL(p.redirectUri);
    target.searchParams.set("code", code);
    if (p.state !== undefined) target.searchParams.set("state", p.state);
    return target.toString();
  }

  // ----------------------------------------------------------------- codes

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const key = hashToken(authorizationCode);
    const code = this.store.codes.get(key);
    if (!code || code.clientId !== client.client_id || code.expiresAt < Date.now()) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    // One attempt per code: a successful exchange deletes it, so a second
    // challenge means the previous PKCE check failed. Burn the code.
    if (code.challenged) {
      this.store.codes.delete(key);
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    code.challenged = true;
    return code.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const key = hashToken(authorizationCode);
    const code = this.store.codes.get(key);
    // Single use, whatever happens next.
    this.store.codes.delete(key);
    if (!code || code.clientId !== client.client_id || code.expiresAt < Date.now()) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    if (redirectUri !== undefined && redirectUri !== code.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    const grantId = randomToken(16);
    this.store.grants.set(grantId, { ...code.grant, createdAt: Date.now() } satisfies Grant);
    this.enforceGrantLimit(code.grant.userId);
    return this.issueTokens(grantId, client.client_id, code.grant.scopes);
  }

  /** Keep at most MAX_GRANTS_PER_USER connections per GLPI user; sign out the oldest. */
  private enforceGrantLimit(userId: number) {
    const mine = [...this.store.grants.entries()].filter(([, g]) => g.userId === userId).sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (const [id] of mine.slice(0, Math.max(0, mine.length - MAX_GRANTS_PER_USER))) this.store.revokeGrant(id);
  }

  private grantExpired(grant: Grant): boolean {
    return grant.createdAt + this.opts.maxGrantAge * 1000 < Date.now();
  }

  private issueTokens(grantId: string, clientId: string, scopes: string[]): OAuthTokens {
    const now = Date.now();
    const accessToken = randomToken();
    const refreshToken = randomToken();
    this.store.access.set(hashToken(accessToken), { grantId, clientId, expiresAt: now + this.opts.accessTokenTtl * 1000 });
    this.store.refresh.set(hashToken(refreshToken), { grantId, clientId, expiresAt: now + this.opts.refreshTokenTtl * 1000 });
    this.store.changed();
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: this.opts.accessTokenTtl,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const key = hashToken(refreshToken);
    const record = this.store.refresh.get(key);
    if (!record) {
      // A refresh token that was already rotated came back: it may have been stolen.
      // Sign the whole connection out (OAuth 2.1 refresh token reuse detection).
      const reused = this.store.rotated.get(key);
      if (reused) this.store.revokeGrant(reused.grantId);
      throw new InvalidGrantError("Invalid or expired refresh token");
    }
    if (record.clientId !== client.client_id || record.expiresAt < Date.now()) {
      throw new InvalidGrantError("Invalid or expired refresh token");
    }
    const grant = this.store.grants.get(record.grantId);
    if (!grant || this.grantExpired(grant)) {
      this.store.revokeGrant(record.grantId);
      throw new InvalidGrantError("This sign-in expired. Connect again.");
    }
    // Rotate: the old refresh token stops working and is remembered to detect reuse.
    this.store.refresh.delete(key);
    this.store.rotated.set(key, { grantId: record.grantId, clientId: record.clientId, expiresAt: record.expiresAt });
    return this.issueTokens(record.grantId, client.client_id, grant.scopes);
  }

  // -------------------------------------------------------------- resources

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.store.access.get(hashToken(token));
    if (!record || record.expiresAt < Date.now()) throw new InvalidTokenError("Invalid or expired access token");
    const grant = this.store.grants.get(record.grantId);
    if (!grant || this.grantExpired(grant)) throw new InvalidTokenError("Invalid or expired access token");
    return {
      token,
      clientId: record.clientId,
      scopes: grant.scopes,
      expiresAt: Math.floor(record.expiresAt / 1000),
      // Every token is bound to this server's MCP endpoint (checked at /authorize).
      resource: new URL(this.opts.resourceUrl),
      extra: { glpiUserToken: grant.glpiUserToken, glpiUserId: grant.userId, glpiLogin: grant.login },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const key = hashToken(request.token);
    for (const map of [this.store.access, this.store.refresh]) {
      const record = map.get(key);
      if (record && record.clientId === client.client_id) {
        // Revoking either token signs the user out of this connection.
        this.store.revokeGrant(record.grantId);
        return;
      }
    }
  }
}
