import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import {
  resolveGoogleOAuthConfig,
  createGoogleOAuthHandlers,
  createNoopOAuthHandlers,
} from "./google-oauth.js";

describe("resolveGoogleOAuthConfig", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns null when not enabled and no env vars", () => {
    const result = resolveGoogleOAuthConfig({
      oauthConfig: undefined,
      env: {},
    });
    expect(result).toBeNull();
  });

  it("returns null when enabled but missing required config", () => {
    const result = resolveGoogleOAuthConfig({
      oauthConfig: { enabled: true },
      env: {},
    });
    expect(result).toBeNull();
  });

  it("resolves config from environment variables", () => {
    const result = resolveGoogleOAuthConfig({
      oauthConfig: undefined,
      env: {
        GOOGLE_CLIENT_ID: "test-client-id",
        GOOGLE_CLIENT_SECRET: "test-secret",
        AUTH_CALLBACK_URL: "http://localhost:3000/auth/google/callback",
      },
    });
    expect(result).not.toBeNull();
    expect(result?.clientId).toBe("test-client-id");
    expect(result?.clientSecret).toBe("test-secret");
    expect(result?.callbackUrl).toBe("http://localhost:3000/auth/google/callback");
    expect(result?.allowedEmailDomains).toEqual([]);
  });

  it("resolves config from config object", () => {
    const result = resolveGoogleOAuthConfig({
      oauthConfig: {
        enabled: true,
        clientId: "config-client-id",
        clientSecret: "config-secret",
        callbackUrl: "http://localhost:3000/callback",
        allowedEmailDomains: "example.com, corp.example.com",
      },
      env: {},
    });
    expect(result).not.toBeNull();
    expect(result?.clientId).toBe("config-client-id");
    expect(result?.allowedEmailDomains).toEqual(["example.com", "corp.example.com"]);
  });

  it("config values take precedence over env vars", () => {
    const result = resolveGoogleOAuthConfig({
      oauthConfig: {
        enabled: true,
        clientId: "config-client-id",
        clientSecret: "config-secret",
        callbackUrl: "http://localhost:3000/callback",
      },
      env: {
        GOOGLE_CLIENT_ID: "env-client-id",
        GOOGLE_CLIENT_SECRET: "env-secret",
        AUTH_CALLBACK_URL: "http://localhost:4000/callback",
      },
    });
    expect(result?.clientId).toBe("config-client-id");
  });

  it("parses allowed email domains correctly", () => {
    const result = resolveGoogleOAuthConfig({
      oauthConfig: {
        enabled: true,
        clientId: "id",
        clientSecret: "secret",
        callbackUrl: "http://localhost/callback",
      },
      env: {
        ALLOWED_EMAIL_DOMAINS: "  Example.COM , CORP.example.com,  ",
      },
    });
    expect(result?.allowedEmailDomains).toEqual(["example.com", "corp.example.com"]);
  });

  it("uses default session max age", () => {
    const result = resolveGoogleOAuthConfig({
      oauthConfig: {
        enabled: true,
        clientId: "id",
        clientSecret: "secret",
        callbackUrl: "http://localhost/callback",
      },
      env: {},
    });
    expect(result?.sessionMaxAgeSec).toBe(7 * 24 * 60 * 60); // 7 days
  });

  it("uses custom session max age", () => {
    const result = resolveGoogleOAuthConfig({
      oauthConfig: {
        enabled: true,
        clientId: "id",
        clientSecret: "secret",
        callbackUrl: "http://localhost/callback",
        sessionMaxAgeSec: 3600,
      },
      env: {},
    });
    expect(result?.sessionMaxAgeSec).toBe(3600);
  });

  it("uses default public paths", () => {
    const result = resolveGoogleOAuthConfig({
      oauthConfig: {
        enabled: true,
        clientId: "id",
        clientSecret: "secret",
        callbackUrl: "http://localhost/callback",
      },
      env: {},
    });
    expect(result?.publicPaths).toEqual(["/health", "/api/health"]);
  });
});

describe("createNoopOAuthHandlers", () => {
  it("returns handlers that do nothing", async () => {
    const handlers = createNoopOAuthHandlers();

    const mockReq = {} as IncomingMessage;
    const mockRes = {} as ServerResponse;

    // handleOAuthRequest should return false (not handled)
    const handled = await handlers.handleOAuthRequest(mockReq, mockRes);
    expect(handled).toBe(false);

    // authMiddleware should return authenticated: true
    const authResult = await handlers.authMiddleware(mockReq, mockRes);
    expect(authResult.authenticated).toBe(true);

    // getSession should return null
    const session = handlers.getSession(mockReq);
    expect(session).toBeNull();
  });
});

describe("createGoogleOAuthHandlers", () => {
  const testConfig = {
    enabled: true,
    clientId: "test-client-id",
    clientSecret: "test-secret",
    callbackUrl: "http://localhost:3000/auth/google/callback",
    allowedEmailDomains: [] as string[],
    sessionSecret: "test-session-secret",
    sessionMaxAgeSec: 3600,
    publicPaths: ["/health", "/api/health"],
  };

  function createMockRequest(
    url: string,
    method = "GET",
    headers: Record<string, string> = {},
  ): IncomingMessage {
    const req = new EventEmitter() as IncomingMessage;
    req.url = url;
    req.method = method;
    req.headers = { host: "localhost:3000", ...headers };
    return req;
  }

  function createMockResponse(): ServerResponse & {
    _statusCode: number;
    _headers: Map<string, string | string[]>;
    _body: string;
  } {
    const res = {
      _statusCode: 200,
      _headers: new Map<string, string | string[]>(),
      _body: "",
      get statusCode() {
        return this._statusCode;
      },
      set statusCode(code: number) {
        this._statusCode = code;
      },
      setHeader(name: string, value: string | string[]) {
        const existing = this._headers.get(name);
        if (name.toLowerCase() === "set-cookie" && existing) {
          const arr = Array.isArray(existing) ? existing : [existing];
          if (Array.isArray(value)) {
            arr.push(...value);
          } else {
            arr.push(value);
          }
          this._headers.set(name, arr);
        } else {
          this._headers.set(name, value);
        }
      },
      getHeader(name: string) {
        return this._headers.get(name);
      },
      end(body?: string) {
        this._body = body ?? "";
      },
    } as unknown as ServerResponse & {
      _statusCode: number;
      _headers: Map<string, string | string[]>;
      _body: string;
    };
    return res;
  }

  it("handles /auth/google route by redirecting to Google", async () => {
    const handlers = createGoogleOAuthHandlers(testConfig);
    const req = createMockRequest("/auth/google");
    const res = createMockResponse();

    const handled = await handlers.handleOAuthRequest(req, res);

    expect(handled).toBe(true);
    expect(res._statusCode).toBe(302);
    const location = res._headers.get("Location") as string;
    expect(location).toContain("accounts.google.com");
    expect(location).toContain("client_id=test-client-id");
  });

  it("handles /auth/logout route", async () => {
    const handlers = createGoogleOAuthHandlers(testConfig);
    const req = createMockRequest("/auth/logout");
    const res = createMockResponse();

    const handled = await handlers.handleOAuthRequest(req, res);

    expect(handled).toBe(true);
    expect(res._statusCode).toBe(302);
    // Should have a Set-Cookie header clearing the session
    const cookies = res._headers.get("Set-Cookie");
    expect(cookies).toBeDefined();
  });

  it("handles /auth/session route", async () => {
    const handlers = createGoogleOAuthHandlers(testConfig);
    const req = createMockRequest("/auth/session");
    const res = createMockResponse();

    const handled = await handlers.handleOAuthRequest(req, res);

    expect(handled).toBe(true);
    expect(res._statusCode).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.authenticated).toBe(false);
  });

  it("does not handle non-auth routes", async () => {
    const handlers = createGoogleOAuthHandlers(testConfig);
    const req = createMockRequest("/some/other/path");
    const res = createMockResponse();

    const handled = await handlers.handleOAuthRequest(req, res);

    expect(handled).toBe(false);
  });

  it("authMiddleware allows public paths", async () => {
    const handlers = createGoogleOAuthHandlers(testConfig);
    const req = createMockRequest("/health");
    const res = createMockResponse();

    const result = await handlers.authMiddleware(req, res);

    expect(result.authenticated).toBe(true);
  });

  it("authMiddleware allows auth routes", async () => {
    const handlers = createGoogleOAuthHandlers(testConfig);
    const req = createMockRequest("/auth/google");
    const res = createMockResponse();

    const result = await handlers.authMiddleware(req, res);

    expect(result.authenticated).toBe(true);
  });

  it("authMiddleware redirects browser requests without session", async () => {
    const handlers = createGoogleOAuthHandlers(testConfig);
    const req = createMockRequest("/", "GET", { accept: "text/html" });
    const res = createMockResponse();

    const result = await handlers.authMiddleware(req, res);

    expect(result.authenticated).toBe(false);
    expect(res._statusCode).toBe(302);
    expect(res._headers.get("Location")).toContain("/auth/google");
  });

  it("authMiddleware returns 401 for API requests without session", async () => {
    const handlers = createGoogleOAuthHandlers(testConfig);
    const req = createMockRequest("/api/data", "GET", { accept: "application/json" });
    const res = createMockResponse();

    const result = await handlers.authMiddleware(req, res);

    expect(result.authenticated).toBe(false);
    expect(res._statusCode).toBe(401);
    const body = JSON.parse(res._body);
    expect(body.error).toBe("Unauthorized");
  });

  it("getSession returns null when no cookie", () => {
    const handlers = createGoogleOAuthHandlers(testConfig);
    const req = createMockRequest("/");

    const session = handlers.getSession(req);

    expect(session).toBeNull();
  });

  it("getSession returns null for invalid cookie", () => {
    const handlers = createGoogleOAuthHandlers(testConfig);
    const req = createMockRequest("/", "GET", { cookie: "moltbot_session=invalid" });

    const session = handlers.getSession(req);

    expect(session).toBeNull();
  });
});
