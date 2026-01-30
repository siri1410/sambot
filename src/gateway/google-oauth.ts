import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GoogleOAuthConfig } from "../config/types.google-oauth.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("google-oauth");

// Session cookie name
const SESSION_COOKIE_NAME = "moltbot_session";
// OAuth state cookie (CSRF protection)
const STATE_COOKIE_NAME = "moltbot_oauth_state";
// Default session max age: 7 days
const DEFAULT_SESSION_MAX_AGE_SEC = 7 * 24 * 60 * 60;
// Google OAuth endpoints
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

export type GoogleOAuthSession = {
  email: string;
  name?: string;
  picture?: string;
  expiresAt: number;
};

export type ResolvedGoogleOAuthConfig = {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  allowedEmailDomains: string[];
  sessionSecret: string;
  sessionMaxAgeSec: number;
  publicPaths: string[];
};

type GoogleUserInfo = {
  email: string;
  name?: string;
  picture?: string;
  verified_email?: boolean;
};

/**
 * Resolve Google OAuth config from config object and environment variables.
 */
export function resolveGoogleOAuthConfig(params: {
  oauthConfig?: GoogleOAuthConfig | null;
  env?: NodeJS.ProcessEnv;
}): ResolvedGoogleOAuthConfig | null {
  const cfg = params.oauthConfig ?? {};
  const env = params.env ?? process.env;

  const enabled = cfg.enabled ?? Boolean(env.GOOGLE_CLIENT_ID);
  if (!enabled) return null;

  const clientId = cfg.clientId ?? env.GOOGLE_CLIENT_ID ?? "";
  const clientSecret = cfg.clientSecret ?? env.GOOGLE_CLIENT_SECRET ?? "";
  const callbackUrl = cfg.callbackUrl ?? env.AUTH_CALLBACK_URL ?? "";

  if (!clientId || !clientSecret || !callbackUrl) {
    log.warn(
      "Google OAuth enabled but missing required config: clientId, clientSecret, or callbackUrl",
    );
    return null;
  }

  const allowedDomainsRaw = cfg.allowedEmailDomains ?? env.ALLOWED_EMAIL_DOMAINS ?? "";
  const allowedEmailDomains = allowedDomainsRaw
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);

  const sessionSecret =
    cfg.sessionSecret ?? env.AUTH_SESSION_SECRET ?? randomBytes(32).toString("hex");
  const sessionMaxAgeSec = cfg.sessionMaxAgeSec ?? DEFAULT_SESSION_MAX_AGE_SEC;

  const publicPaths = cfg.publicPaths ?? ["/health", "/api/health"];

  return {
    enabled: true,
    clientId,
    clientSecret,
    callbackUrl,
    allowedEmailDomains,
    sessionSecret,
    sessionMaxAgeSec,
    publicPaths,
  };
}

/**
 * Generate a signed session token.
 */
function signSession(session: GoogleOAuthSession, secret: string): string {
  const payload = JSON.stringify(session);
  const payloadBase64 = Buffer.from(payload).toString("base64url");
  const sig = createHmac("sha256", secret).update(payloadBase64).digest("base64url");
  return `${payloadBase64}.${sig}`;
}

/**
 * Verify and decode a signed session token.
 */
function verifySession(token: string, secret: string): GoogleOAuthSession | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [payloadBase64, sig] = parts;
  if (!payloadBase64 || !sig) return null;

  const expectedSig = createHmac("sha256", secret).update(payloadBase64).digest("base64url");

  // Timing-safe comparison
  if (sig.length !== expectedSig.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;

  try {
    const payload = Buffer.from(payloadBase64, "base64url").toString("utf8");
    const session = JSON.parse(payload) as GoogleOAuthSession;

    // Check expiration
    if (session.expiresAt < Date.now()) {
      return null;
    }

    return session;
  } catch {
    return null;
  }
}

/**
 * Parse cookies from request headers.
 */
function parseCookies(req: IncomingMessage): Record<string, string> {
  const cookieHeader = req.headers.cookie ?? "";
  const cookies: Record<string, string> = {};

  for (const pair of cookieHeader.split(";")) {
    const [name, ...valueParts] = pair.trim().split("=");
    if (name) {
      cookies[name] = valueParts.join("=");
    }
  }

  return cookies;
}

/**
 * Set a cookie on the response.
 */
function setCookie(
  res: ServerResponse,
  name: string,
  value: string,
  opts: {
    maxAge?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Lax" | "Strict" | "None";
    path?: string;
  } = {},
): void {
  const parts = [`${name}=${value}`];

  if (opts.maxAge !== undefined) {
    parts.push(`Max-Age=${opts.maxAge}`);
  }
  if (opts.httpOnly !== false) {
    parts.push("HttpOnly");
  }
  if (opts.secure) {
    parts.push("Secure");
  }
  parts.push(`SameSite=${opts.sameSite ?? "Lax"}`);
  parts.push(`Path=${opts.path ?? "/"}`);

  const existing = res.getHeader("Set-Cookie");
  const cookies = existing ? (Array.isArray(existing) ? existing : [String(existing)]) : [];
  cookies.push(parts.join("; "));
  res.setHeader("Set-Cookie", cookies);
}

/**
 * Clear a cookie.
 */
function clearCookie(res: ServerResponse, name: string): void {
  setCookie(res, name, "", { maxAge: 0 });
}

/**
 * Generate a random state for CSRF protection.
 */
function generateState(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Check if an email is allowed based on domain whitelist.
 */
function isEmailAllowed(email: string, allowedDomains: string[]): boolean {
  if (allowedDomains.length === 0) return true;

  const emailLower = email.toLowerCase();
  const domain = emailLower.split("@")[1];
  if (!domain) return false;

  return allowedDomains.includes(domain);
}

/**
 * Send JSON response.
 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

/**
 * Redirect response.
 */
function sendRedirect(res: ServerResponse, url: string): void {
  res.statusCode = 302;
  res.setHeader("Location", url);
  res.end();
}

/**
 * Exchange authorization code for tokens.
 */
async function exchangeCodeForTokens(
  code: string,
  config: ResolvedGoogleOAuthConfig,
): Promise<{ access_token: string; id_token?: string } | null> {
  try {
    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.callbackUrl,
        grant_type: "authorization_code",
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      log.warn(`Token exchange failed: ${response.status} ${text}`);
      return null;
    }

    return (await response.json()) as { access_token: string; id_token?: string };
  } catch (err) {
    log.warn(`Token exchange error: ${String(err)}`);
    return null;
  }
}

/**
 * Fetch user info from Google.
 */
async function fetchUserInfo(accessToken: string): Promise<GoogleUserInfo | null> {
  try {
    const response = await fetch(GOOGLE_USERINFO_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      log.warn(`User info fetch failed: ${response.status}`);
      return null;
    }

    return (await response.json()) as GoogleUserInfo;
  } catch (err) {
    log.warn(`User info fetch error: ${String(err)}`);
    return null;
  }
}

export type GoogleOAuthRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean>;

export type GoogleOAuthMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<{ authenticated: boolean; session?: GoogleOAuthSession }>;

/**
 * Create Google OAuth route handlers.
 */
export function createGoogleOAuthHandlers(config: ResolvedGoogleOAuthConfig): {
  handleOAuthRequest: GoogleOAuthRequestHandler;
  authMiddleware: GoogleOAuthMiddleware;
  getSession: (req: IncomingMessage) => GoogleOAuthSession | null;
} {
  const isSecure = config.callbackUrl.startsWith("https://");

  /**
   * Get current session from request.
   */
  function getSession(req: IncomingMessage): GoogleOAuthSession | null {
    const cookies = parseCookies(req);
    const sessionToken = cookies[SESSION_COOKIE_NAME];
    if (!sessionToken) return null;
    return verifySession(sessionToken, config.sessionSecret);
  }

  /**
   * Handle OAuth-related routes.
   */
  async function handleOAuthRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    // Handle /auth/google - initiate OAuth flow
    if (pathname === "/auth/google" && req.method === "GET") {
      const state = generateState();
      const returnTo = url.searchParams.get("returnTo") ?? "/";

      // Store state with return URL
      setCookie(res, STATE_COOKIE_NAME, `${state}:${returnTo}`, {
        maxAge: 600, // 10 minutes
        httpOnly: true,
        secure: isSecure,
        sameSite: "Lax",
      });

      const authUrl = new URL(GOOGLE_AUTH_URL);
      authUrl.searchParams.set("client_id", config.clientId);
      authUrl.searchParams.set("redirect_uri", config.callbackUrl);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", "openid email profile");
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("access_type", "online");
      authUrl.searchParams.set("prompt", "select_account");

      sendRedirect(res, authUrl.toString());
      return true;
    }

    // Handle /auth/google/callback - OAuth callback
    if (pathname === "/auth/google/callback" && req.method === "GET") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      // Clear state cookie
      const cookies = parseCookies(req);
      const stateCookie = cookies[STATE_COOKIE_NAME] ?? "";
      clearCookie(res, STATE_COOKIE_NAME);

      if (error) {
        log.warn(`OAuth error: ${error}`);
        sendJson(res, 400, { error: `OAuth error: ${error}` });
        return true;
      }

      if (!code || !state) {
        sendJson(res, 400, { error: "Missing code or state" });
        return true;
      }

      // Verify state (CSRF protection)
      const [expectedState, returnTo] = stateCookie.split(":");
      if (state !== expectedState) {
        log.warn("OAuth state mismatch (possible CSRF attack)");
        sendJson(res, 400, { error: "Invalid state" });
        return true;
      }

      // Exchange code for tokens
      const tokens = await exchangeCodeForTokens(code, config);
      if (!tokens) {
        sendJson(res, 500, { error: "Failed to exchange code for tokens" });
        return true;
      }

      // Fetch user info
      const userInfo = await fetchUserInfo(tokens.access_token);
      if (!userInfo?.email) {
        sendJson(res, 500, { error: "Failed to fetch user info" });
        return true;
      }

      // Check email domain whitelist
      if (!isEmailAllowed(userInfo.email, config.allowedEmailDomains)) {
        log.warn(`Email domain not allowed: ${userInfo.email}`);
        sendJson(res, 403, {
          error: "Access denied",
          message: "Your email domain is not authorized to access this application.",
        });
        return true;
      }

      // Create session
      const session: GoogleOAuthSession = {
        email: userInfo.email,
        name: userInfo.name,
        picture: userInfo.picture,
        expiresAt: Date.now() + config.sessionMaxAgeSec * 1000,
      };

      const sessionToken = signSession(session, config.sessionSecret);
      setCookie(res, SESSION_COOKIE_NAME, sessionToken, {
        maxAge: config.sessionMaxAgeSec,
        httpOnly: true,
        secure: isSecure,
        sameSite: "Lax",
      });

      log.info(`User authenticated: ${userInfo.email}`);

      // Redirect to return URL or home
      sendRedirect(res, returnTo || "/");
      return true;
    }

    // Handle /auth/logout - clear session
    if (pathname === "/auth/logout" && (req.method === "GET" || req.method === "POST")) {
      clearCookie(res, SESSION_COOKIE_NAME);
      const returnTo = url.searchParams.get("returnTo") ?? "/";
      sendRedirect(res, returnTo);
      return true;
    }

    // Handle /auth/session - get current session info (API)
    if (pathname === "/auth/session" && req.method === "GET") {
      const session = getSession(req);
      if (session) {
        sendJson(res, 200, {
          authenticated: true,
          email: session.email,
          name: session.name,
          picture: session.picture,
        });
      } else {
        sendJson(res, 200, { authenticated: false });
      }
      return true;
    }

    return false;
  }

  /**
   * Authentication middleware - checks if request is authenticated.
   */
  async function authMiddleware(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<{ authenticated: boolean; session?: GoogleOAuthSession }> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    // Skip auth for public paths
    for (const publicPath of config.publicPaths) {
      if (pathname === publicPath || pathname.startsWith(`${publicPath}/`)) {
        return { authenticated: true };
      }
    }

    // Skip auth for OAuth routes themselves
    if (pathname.startsWith("/auth/")) {
      return { authenticated: true };
    }

    const session = getSession(req);
    if (session) {
      return { authenticated: true, session };
    }

    // Not authenticated - check if this is an API request or browser request
    const acceptHeader = req.headers.accept ?? "";
    const isApiRequest =
      acceptHeader.includes("application/json") ||
      req.headers["x-requested-with"] === "XMLHttpRequest";

    if (isApiRequest) {
      // API request - return 401
      sendJson(res, 401, { error: "Unauthorized", loginUrl: "/auth/google" });
    } else {
      // Browser request - redirect to login
      const returnTo = encodeURIComponent(req.url ?? "/");
      sendRedirect(res, `/auth/google?returnTo=${returnTo}`);
    }

    return { authenticated: false };
  }

  return {
    handleOAuthRequest,
    authMiddleware,
    getSession,
  };
}

/**
 * Create a no-op OAuth handler when OAuth is disabled.
 */
export function createNoopOAuthHandlers(): {
  handleOAuthRequest: GoogleOAuthRequestHandler;
  authMiddleware: GoogleOAuthMiddleware;
  getSession: (req: IncomingMessage) => GoogleOAuthSession | null;
} {
  return {
    handleOAuthRequest: async () => false,
    authMiddleware: async () => ({ authenticated: true }),
    getSession: () => null,
  };
}
