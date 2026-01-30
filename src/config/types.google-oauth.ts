/**
 * Google OAuth configuration for Gateway authentication.
 */
export type GoogleOAuthConfig = {
  /** Enable Google OAuth authentication for the Control UI and API. */
  enabled?: boolean;
  /**
   * Google OAuth Client ID.
   * Can be set via config or GOOGLE_CLIENT_ID env var.
   */
  clientId?: string;
  /**
   * Google OAuth Client Secret.
   * Can be set via config or GOOGLE_CLIENT_SECRET env var.
   */
  clientSecret?: string;
  /**
   * OAuth callback URL (e.g., http://localhost:18789/auth/google/callback).
   * Can be set via config or AUTH_CALLBACK_URL env var.
   */
  callbackUrl?: string;
  /**
   * Comma-separated list of allowed email domains (e.g., "example.com,corp.example.com").
   * If not set, all authenticated Google accounts are allowed.
   * Can be set via config or ALLOWED_EMAIL_DOMAINS env var.
   */
  allowedEmailDomains?: string;
  /**
   * Session secret for signing cookies.
   * If not set, a random secret is generated at startup.
   * Can be set via config or AUTH_SESSION_SECRET env var.
   */
  sessionSecret?: string;
  /**
   * Session cookie max age in seconds (default: 7 days = 604800).
   */
  sessionMaxAgeSec?: number;
  /**
   * Paths that bypass OAuth authentication (e.g., health checks).
   * Default: ["/health", "/api/health"]
   */
  publicPaths?: string[];
};
