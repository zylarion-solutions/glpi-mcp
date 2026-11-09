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
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
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
  validateToken: TokenValidator;
}

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
        this.store.clients.set(full.client_id, full);
        this.store.changed();
        return full;
      },
    };
  }

  // ------------------------------------------------------------ login form

  /** Encrypt and authenticate the authorization request into one form field (AES-256-GCM). */
  sealRequest(p: PendingAuthorization): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.formKey, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(p), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
  }

  openRequest(sealed: string): PendingAuthorization {
    let p: PendingAuthorization;
    try {
      const raw = Buffer.from(String(sealed), "base64url");
      if (raw.length < 29) throw new Error("short");
      const decipher = createDecipheriv("aes-256-gcm", this.formKey, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      p = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8"));
    } catch {
      throw new Error("Invalid login request");
    }
    if (p.exp < Date.now()) throw new Error("The sign-in page expired. Start the connection again from your app.");
    return p;
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const pending: PendingAuthorization = {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes?.length ? params.scopes : [OAUTH_SCOPE],
      resource: params.resource?.toString(),
      exp: Date.now() + LOGIN_FORM_TTL_MS,
    };
    this.sendLoginPage(res, this.sealRequest(pending), client.client_name);
  }

  sendLoginPage(res: Response, sealed: string, clientName?: string, error?: string, status = 200) {
    res
      .status(status)
      .set({
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
      })
      .send(renderLoginPage({ sealed, clientName, glpiUrl: this.opts.glpiUrl, error }));
  }

  /**
   * Handle the submitted login form. Returns the URL to redirect the browser to,
   * or throws a user-facing error (the caller re-renders the form).
   */
  async completeLogin(sealed: string, glpiUserToken: string): Promise<string> {
    const p = this.openRequest(sealed);
    const client = this.store.clients.get(p.clientId);
    if (!client || !client.redirect_uris.includes(p.redirectUri)) throw new Error("Unknown application. Start again from your app.");
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
    return this.issueTokens(grantId, client.client_id, code.grant.scopes);
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
    if (!record || record.clientId !== client.client_id || record.expiresAt < Date.now()) {
      throw new InvalidGrantError("Invalid or expired refresh token");
    }
    const grant = this.store.grants.get(record.grantId);
    if (!grant) throw new InvalidGrantError("Invalid or expired refresh token");
    // Rotate: the old refresh token stops working.
    this.store.refresh.delete(key);
    return this.issueTokens(record.grantId, client.client_id, grant.scopes);
  }

  // -------------------------------------------------------------- resources

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.store.access.get(hashToken(token));
    if (!record || record.expiresAt < Date.now()) throw new InvalidTokenError("Invalid or expired access token");
    const grant = this.store.grants.get(record.grantId);
    if (!grant) throw new InvalidTokenError("Invalid or expired access token");
    return {
      token,
      clientId: record.clientId,
      scopes: grant.scopes,
      expiresAt: Math.floor(record.expiresAt / 1000),
      resource: grant.resource ? new URL(grant.resource) : undefined,
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
