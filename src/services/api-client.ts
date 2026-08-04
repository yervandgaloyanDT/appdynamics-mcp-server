/**
 * Shared HTTP client for AppDynamics REST API.
 * All API calls go through this module to ensure consistent auth, timeouts, and error handling.
 */

import axios from "axios";
import type { Method } from "axios";
import { getAccessToken, getBaseUrl, invalidateToken, isOAuthConfigured } from "./auth.js";
import { API_TIMEOUT_MS } from "../constants.js";

type QueryParams = Record<string, string | number | boolean | undefined>;

interface RequestOptions {
  method: Method;
  path: string;
  params?: QueryParams | undefined;
  data?: unknown;
  /** Extra headers merged over the Authorization header. */
  headers?: Record<string, string> | undefined;
  /**
   * Whether a 401 should invalidate the cached token and retry once.
   * Disabled for multipart bodies, which cannot be safely replayed.
   */
  retryOn401?: boolean;
}

/**
 * Drop undefined values so axios does not serialize them as empty parameters.
 */
function cleanParams(params: QueryParams | undefined, base: QueryParams = {}): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};

  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) result[key] = value;
  }
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) result[key] = value;
    }
  }

  return result;
}

function isUnauthorized(error: unknown): boolean {
  return (
    error instanceof Error &&
    "isAxiosError" in error &&
    (error as { response?: { status?: number } }).response?.status === 401
  );
}

/**
 * Execute an authenticated request, retrying once on 401 with a fresh token.
 *
 * A cached token can be rejected before its advertised expiry (revoked client,
 * controller restart). Without the retry every subsequent call fails until the
 * cache times out on its own.
 */
async function request<T>(options: RequestOptions): Promise<T> {
  const { method, path, params, data, headers, retryOn401 = true } = options;
  const baseUrl = getBaseUrl();

  const send = async (token: string): Promise<T> => {
    const response = await axios({
      method,
      url: `${baseUrl}${path}`,
      ...(params !== undefined ? { params } : {}),
      ...(data !== undefined ? { data } : {}),
      headers: {
        Authorization: `Bearer ${token}`,
        ...headers,
      },
      timeout: API_TIMEOUT_MS,
    });
    return response.data as T;
  };

  const token = await getAccessToken();

  try {
    return await send(token);
  } catch (error) {
    if (retryOn401 && isUnauthorized(error) && isOAuthConfigured()) {
      invalidateToken();
      return await send(await getAccessToken());
    }
    throw error;
  }
}

/**
 * Make an authenticated GET request to the AppDynamics REST API.
 * Automatically appends output=JSON query parameter.
 */
export async function appdGet<T = unknown>(
  path: string,
  params?: QueryParams
): Promise<T> {
  return request<T>({
    method: "GET",
    path,
    params: cleanParams(params, { output: "JSON" }),
  });
}

/**
 * Make an authenticated POST request to the AppDynamics REST API.
 */
export async function appdPost<T = unknown>(
  path: string,
  data?: unknown,
  params?: QueryParams
): Promise<T> {
  return request<T>({
    method: "POST",
    path,
    params: cleanParams(params),
    data,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Make an authenticated POST request with multipart/form-data.
 * Used for servlet endpoints that expect a file upload (e.g. CustomDashboardImportExportServlet).
 * Content-Type header is intentionally omitted so axios sets it with the correct multipart boundary.
 *
 * Not retried on 401 — a consumed multipart body cannot be replayed reliably.
 */
export async function appdPostFormData<T = unknown>(
  path: string,
  formData: FormData
): Promise<T> {
  return request<T>({
    method: "POST",
    path,
    data: formData,
    retryOn401: false,
  });
}

/**
 * Make an authenticated PUT request to the AppDynamics REST API.
 */
export async function appdPut<T = unknown>(
  path: string,
  data?: unknown,
  params?: QueryParams
): Promise<T> {
  return request<T>({
    method: "PUT",
    path,
    params: cleanParams(params),
    data,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Make an authenticated DELETE request to the AppDynamics REST API.
 */
export async function appdDelete<T = unknown>(path: string): Promise<T> {
  return request<T>({ method: "DELETE", path });
}

/**
 * Make an authenticated GET request without adding output=JSON.
 * Used for endpoints that don't support the output parameter (e.g., restui endpoints).
 */
export async function appdGetRaw<T = unknown>(
  path: string,
  params?: QueryParams
): Promise<T> {
  return request<T>({
    method: "GET",
    path,
    params: cleanParams(params),
  });
}
