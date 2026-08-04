/**
 * OAuth2 authentication service for AppDynamics API.
 * Handles token acquisition, caching, and refresh.
 */

import axios from "axios";
import { TOKEN_EXPIRY_SAFETY_MARGIN_SECS } from "../constants.js";

const APPD_URL = process.env.APPD_URL;
const CLIENT_NAME = process.env.APPD_CLIENT_NAME || process.env.APPD_API_KEY;
const CLIENT_SECRET = process.env.APPD_CLIENT_SECRET;
const ACCOUNT_NAME = process.env.APPD_ACCOUNT_NAME;

interface OAuthResponse {
  access_token: string;
  expires_in: number;
}

let accessToken: string | null = null;
let tokenExpiry: number = 0;

/**
 * In-flight token request, shared by all concurrent callers.
 *
 * Tools such as appd_get_health_violations fan out across every application at
 * once. Without this, a cold cache produces one OAuth request per concurrent
 * call instead of one total.
 */
let inFlightTokenRequest: Promise<string> | null = null;

/**
 * Get a valid OAuth access token, using cache when possible.
 * Falls back to API key if only CLIENT_NAME is set (no secret).
 */
export async function getAccessToken(): Promise<string> {
  if (!CLIENT_NAME) {
    throw new Error(
      "AppDynamics authentication not configured. Set APPD_CLIENT_NAME and APPD_CLIENT_SECRET, or APPD_API_KEY."
    );
  }

  // Return cached token if still valid
  if (accessToken && Date.now() < tokenExpiry) {
    return accessToken;
  }

  // No secret configured — use client name as a direct API key.
  if (!CLIENT_SECRET) {
    return CLIENT_NAME;
  }

  // Join an already-running token request rather than starting a second one.
  if (inFlightTokenRequest) {
    return inFlightTokenRequest;
  }

  inFlightTokenRequest = requestNewToken(CLIENT_NAME, CLIENT_SECRET).finally(
    () => {
      inFlightTokenRequest = null;
    }
  );

  return inFlightTokenRequest;
}

/**
 * Perform the OAuth2 client-credentials exchange and populate the cache.
 */
async function requestNewToken(
  clientName: string,
  clientSecret: string
): Promise<string> {
  const clientId = ACCOUNT_NAME ? `${clientName}@${ACCOUNT_NAME}` : clientName;

  try {
    const response = await axios.post<OAuthResponse>(
      `${APPD_URL}/controller/api/oauth/access_token`,
      new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );

    const token = response.data.access_token;
    if (!token) {
      throw new Error("No access_token in OAuth response");
    }

    accessToken = token;
    tokenExpiry =
      Date.now() +
      (response.data.expires_in - TOKEN_EXPIRY_SAFETY_MARGIN_SECS) * 1000;
    return token;
  } catch (error: unknown) {
    accessToken = null;
    tokenExpiry = 0;

    if (error instanceof Error && "isAxiosError" in error) {
      const axErr = error as Error & {
        response?: { status: number };
      };
      // Log only the HTTP status code — never log response body (may contain credentials)
      const details = axErr.response
        ? `HTTP ${axErr.response.status}`
        : "network error";
      console.error(`OAuth authentication failed: ${details}`);
    }
    throw new Error(
      "OAuth authentication failed. Check APPD_CLIENT_NAME, APPD_CLIENT_SECRET, and APPD_ACCOUNT_NAME."
    );
  }
}

/**
 * Discard the cached token so the next call fetches a fresh one.
 *
 * Called when the controller rejects a token with 401 — a token can be revoked
 * or invalidated (e.g. controller restart) well before its advertised expiry,
 * and without this every request would keep failing until the cache timed out.
 */
export function invalidateToken(): void {
  accessToken = null;
  tokenExpiry = 0;
}

/**
 * True when OAuth is configured. API-key mode has no token to refresh,
 * so a 401 retry would be pointless.
 */
export function isOAuthConfigured(): boolean {
  return Boolean(CLIENT_NAME && CLIENT_SECRET);
}

/**
 * Get the configured AppDynamics controller base URL.
 */
export function getBaseUrl(): string {
  if (!APPD_URL) {
    throw new Error("APPD_URL environment variable is not set.");
  }
  return APPD_URL;
}
