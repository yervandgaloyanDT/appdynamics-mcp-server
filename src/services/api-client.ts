/**
 * Shared HTTP client for AppDynamics REST API.
 * All API calls go through this module to ensure consistent auth, timeouts, and error handling.
 */

import axios from "axios";
import { getAccessToken, getBaseUrl } from "./auth.js";
import { API_TIMEOUT_MS } from "../constants.js";

/**
 * Make an authenticated GET request to the AppDynamics REST API.
 * Automatically appends output=JSON query parameter.
 */
export async function appdGet<T = unknown>(
  path: string,
  params?: Record<string, string | number | boolean | undefined>
): Promise<T> {
  const token = await getAccessToken();
  const baseUrl = getBaseUrl();

  const cleanParams: Record<string, string | number | boolean> = {
    output: "JSON",
  };
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        cleanParams[key] = value;
      }
    }
  }

  const response = await axios({
    method: "GET",
    url: `${baseUrl}${path}`,
    params: cleanParams,
    headers: { Authorization: `Bearer ${token}` },
    timeout: API_TIMEOUT_MS,
  });

  return response.data as T;
}

/**
 * Make an authenticated POST request to the AppDynamics REST API.
 */
export async function appdPost<T = unknown>(
  path: string,
  data?: unknown,
  params?: Record<string, string | number | boolean | undefined>
): Promise<T> {
  const token = await getAccessToken();
  const baseUrl = getBaseUrl();

  const cleanParams: Record<string, string | number | boolean> = {};
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        cleanParams[key] = value;
      }
    }
  }

  const response = await axios({
    method: "POST",
    url: `${baseUrl}${path}`,
    data,
    params: cleanParams,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    timeout: API_TIMEOUT_MS,
  });

  return response.data as T;
}

/**
 * Make an authenticated POST request with multipart/form-data.
 * Used for servlet endpoints that expect a file upload (e.g. CustomDashboardImportExportServlet).
 * Content-Type header is intentionally omitted so axios sets it with the correct multipart boundary.
 */
export async function appdPostFormData<T = unknown>(
  path: string,
  formData: FormData
): Promise<T> {
  const token = await getAccessToken();
  const baseUrl = getBaseUrl();

  const response = await axios({
    method: "POST",
    url: `${baseUrl}${path}`,
    data: formData,
    headers: { Authorization: `Bearer ${token}` },
    timeout: API_TIMEOUT_MS,
  });

  return response.data as T;
}

/**
 * Make an authenticated DELETE request to the AppDynamics REST API.
 */
export async function appdDelete<T = unknown>(path: string): Promise<T> {
  const token = await getAccessToken();
  const baseUrl = getBaseUrl();

  const response = await axios({
    method: "DELETE",
    url: `${baseUrl}${path}`,
    headers: { Authorization: `Bearer ${token}` },
    timeout: API_TIMEOUT_MS,
  });

  return response.data as T;
}

/**
 * Make an authenticated GET request without adding output=JSON.
 * Used for endpoints that don't support the output parameter (e.g., restui endpoints).
 */
export async function appdGetRaw<T = unknown>(
  path: string,
  params?: Record<string, string | number | boolean | undefined>
): Promise<T> {
  const token = await getAccessToken();
  const baseUrl = getBaseUrl();

  const cleanParams: Record<string, string | number | boolean> = {};
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        cleanParams[key] = value;
      }
    }
  }

  const response = await axios({
    method: "GET",
    url: `${baseUrl}${path}`,
    params: cleanParams,
    headers: { Authorization: `Bearer ${token}` },
    timeout: API_TIMEOUT_MS,
  });

  return response.data as T;
}
