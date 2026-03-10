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

  // Try OAuth2 client credentials flow
  if (CLIENT_SECRET) {
    const clientId = ACCOUNT_NAME
      ? `${CLIENT_NAME}@${ACCOUNT_NAME}`
      : CLIENT_NAME;

    try {
      const response = await axios.post<OAuthResponse>(
        `${APPD_URL}/controller/api/oauth/access_token`,
        new URLSearchParams({
          grant_type: "client_credentials",
          client_id: clientId,
          client_secret: CLIENT_SECRET,
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
      if (
        error instanceof Error &&
        "isAxiosError" in error
      ) {
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

  // Fallback: use client name as direct API key
  return CLIENT_NAME;
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
