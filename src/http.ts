/**
 * Streamable HTTP transport (POST /mcp), stateless: each request gets its own
 * MCP server instance, while GLPI sessions are shared between requests.
 *
 * Two auth modes:
 * - token (default): a static bearer token (MCP_AUTH_TOKEN). Tools act as the
 *   configured service account, or, with MCP_ALLOW_USER_TOKENS=true, as the GLPI
 *   user whose personal token the client sends in X-GLPI-User-Token.
 * - oauth: an OAuth 2.1 authorization server (dynamic client registration +
 *   PKCE) for claude.ai custom connectors; each person signs in with their own
 *   GLPI API token and acts with their own GLPI rights.
 *
 * Put it behind HTTPS (reverse proxy, tunnel, PaaS) before exposing it.
 */
import { timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { ConfigError, type Config } from "./config.js";
import { BackendProvider, UserBackendPool, type BackendSource } from "./glpi/factory.js";
import type { FetchLike } from "./glpi/http.js";
import { LegacyBackend } from "./glpi/legacy.js";
import { GlpiOAuthProvider, OAUTH_SCOPE } from "./oauth/provider.js";
import { OAuthStore } from "./oauth/store.js";
import { createServer } from "./server.js";
import { VERSION } from "./version.js";

const USER_TOKEN_HEADER = "x-glpi-user-token";
const GLPI_TOKEN_RE = /^[A-Za-z0-9]{20,128}$/;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export interface HttpDeps {
  fetchImpl?: FetchLike;
  shared?: BackendProvider;
  pool?: UserBackendPool;
  store?: OAuthStore;
}

export interface HttpApp {
  app: express.Express;
  close(): Promise<void>;
}

export function createHttpApp(config: Config, deps: HttpDeps = {}): HttpApp {
  const http = config.http;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const shared = deps.shared ?? new BackendProvider(config, fetchImpl);
  const pool = deps.pool ?? new UserBackendPool(config, fetchImpl);

  const app = express();
  app.disable("x-powered-by");
  if (http.trustProxy) app.set("trust proxy", http.trustProxy);

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", name: "glpi-mcp", version: VERSION, auth: http.authMode });
  });

  const originGuard = (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && http.allowedOrigins.length && !http.allowedOrigins.includes(origin)) {
      res.status(403).json({ error: "origin not allowed" });
      return;
    }
    next();
  };

  const serve = async (req: Request, res: Response, source: BackendSource) => {
    const server = createServer(config, source);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[glpi-mcp] request failed:", (err as Error).message);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  };

  // Stateless server: no SSE stream or session to resume or end.
  const notAllowed = (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed" },
      id: null,
    });
  };

  let store: OAuthStore | undefined;
  let sweeper: NodeJS.Timeout | undefined;

  if (http.authMode === "oauth") {
    const secret = http.oauth.secret;
    if (!http.publicUrl) throw new ConfigError("MCP_AUTH_MODE=oauth needs MCP_PUBLIC_URL (the https URL clients use)");
    if (!secret || secret.length < 32) throw new ConfigError("MCP_AUTH_MODE=oauth needs MCP_OAUTH_SECRET (32+ random characters)");

    store = deps.store ?? new OAuthStore(secret, http.oauth.stateFile);
    const oauthStore = store;
    sweeper = setInterval(() => oauthStore.sweep(), 60_000);
    sweeper.unref();

    const issuer = new URL(http.publicUrl);
    const resourceUrl = new URL("/mcp", issuer);
    const provider = new GlpiOAuthProvider(oauthStore, {
      resourceUrl: resourceUrl.toString(),
      secret,
      glpiUrl: config.glpiUrl,
      accessTokenTtl: http.oauth.accessTokenTtl,
      refreshTokenTtl: http.oauth.refreshTokenTtl,
      maxGrantAge: http.oauth.maxGrantAge,
      redirectHosts: http.oauth.redirectHosts,
      validateToken: async (token) => {
        const probe = new LegacyBackend(config, fetchImpl, { userToken: token });
        try {
          const s = await probe.session();
          if (!Number.isFinite(s.userId) || s.userId <= 0) throw new Error("no user");
          return { userId: s.userId, login: s.login, name: s.name };
        } finally {
          await probe.close();
        }
      },
    });

    app.use(
      mcpAuthRouter({
        provider,
        issuerUrl: issuer,
        resourceServerUrl: resourceUrl,
        scopesSupported: [OAUTH_SCOPE],
        resourceName: "GLPI",
      }),
    );

    const loginLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 10,
      skipSuccessfulRequests: true,
      standardHeaders: "draft-7",
      legacyHeaders: false,
    });
    app.post("/login", loginLimiter, express.urlencoded({ extended: false, limit: "16kb" }), async (req, res) => {
      const sealed = String(req.body?.request ?? "");
      try {
        const target = await provider.completeLogin(sealed, String(req.body?.glpi_user_token ?? ""));
        res.redirect(302, target);
      } catch (err) {
        let pending: { clientId: string; redirectUri: string };
        try {
          pending = provider.openRequest(sealed);
        } catch {
          res.status(400).type("text/plain").send("Invalid or expired sign-in request. Start the connection again from your app.");
          return;
        }
        const clientName = oauthStore.clients.get(pending.clientId)?.client_name;
        provider.sendLoginPage(res, sealed, pending.redirectUri, clientName, (err as Error).message, 400);
      }
    });

    const bearer = requireBearerAuth({
      verifier: provider,
      requiredScopes: [OAUTH_SCOPE],
      expectedResource: resourceUrl,
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
    });
    app.post("/mcp", originGuard, bearer, express.json({ limit: "16mb" }), (req, res) => {
      const glpiUserToken = req.auth?.extra?.glpiUserToken;
      if (typeof glpiUserToken !== "string") {
        res.status(401).json({ error: "invalid_token" });
        return;
      }
      void serve(req, res, pool.forToken(glpiUserToken));
    });
    app.get("/mcp", originGuard, bearer, notAllowed);
    app.delete("/mcp", originGuard, bearer, notAllowed);
  } else {
    if (!http.authToken && !http.allowNoAuth) {
      throw new ConfigError(
        "MCP_TRANSPORT=http needs MCP_AUTH_TOKEN (clients send it as 'Authorization: Bearer <token>'), " +
          "or MCP_AUTH_MODE=oauth. Set MCP_ALLOW_NO_AUTH=true only for local testing.",
      );
    }
    const tokenGuard = (req: Request, res: Response, next: NextFunction) => {
      if (http.authToken) {
        const header = req.headers.authorization ?? "";
        const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
        if (!token || !safeEqual(token, http.authToken)) {
          res.status(401).set("WWW-Authenticate", 'Bearer realm="glpi-mcp"').json({ error: "unauthorized" });
          return;
        }
      }
      next();
    };
    app.post("/mcp", originGuard, tokenGuard, express.json({ limit: "16mb" }), (req, res) => {
      const userToken = req.headers[USER_TOKEN_HEADER];
      if (userToken !== undefined) {
        if (!http.allowUserTokens) {
          res.status(400).json({ error: "X-GLPI-User-Token is not enabled on this server (MCP_ALLOW_USER_TOKENS)" });
          return;
        }
        if (typeof userToken !== "string" || !GLPI_TOKEN_RE.test(userToken)) {
          res.status(400).json({ error: "X-GLPI-User-Token is not a valid GLPI API token" });
          return;
        }
        void serve(req, res, pool.forToken(userToken));
        return;
      }
      void serve(req, res, shared);
    });
    app.get("/mcp", originGuard, tokenGuard, notAllowed);
    app.delete("/mcp", originGuard, tokenGuard, notAllowed);
  }

  return {
    app,
    async close() {
      clearInterval(sweeper);
      store?.saveNow();
      await Promise.all([shared.close(), pool.close()]);
    },
  };
}

export function startHttp(config: Config): Promise<{ server: Server; close: () => Promise<void> }> {
  const { app, close } = createHttpApp(config);
  return new Promise((resolve) => {
    const server = app.listen(config.http.port, config.http.host, () => {
      console.error(
        `[glpi-mcp] listening on http://${config.http.host}:${config.http.port}/mcp (auth: ${config.http.authMode})`,
      );
      resolve({ server, close });
    });
  });
}
