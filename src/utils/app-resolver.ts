/**
 * Application name → ID resolver.
 * Allows tools to accept either an application name or numeric ID,
 * making the MCP server much more natural to use.
 */

import { appdGet } from "../services/api-client.js";
import type { AppDApplication } from "../types.js";

// Simple cache of applications list (refreshed when stale)
let cachedApps: AppDApplication[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch and cache the list of all applications.
 */
async function getApplicationsList(): Promise<AppDApplication[]> {
  if (cachedApps && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedApps;
  }

  const apps = await appdGet<AppDApplication[]>(
    "/controller/rest/applications"
  );
  cachedApps = apps;
  cacheTimestamp = Date.now();
  return apps;
}

/**
 * Resolve an application identifier (name or ID) to a numeric ID.
 *
 * - If `appIdentifier` is a number, returns it directly.
 * - If it's a string that parses as a number, returns the parsed number.
 * - Otherwise, searches the applications list by name (case-insensitive).
 *
 * Throws if no matching application is found.
 */
export async function resolveAppId(
  appIdentifier: string | number
): Promise<number> {
  // Already a number
  if (typeof appIdentifier === "number") {
    return appIdentifier;
  }

  // String that looks like a number
  const parsed = Number(appIdentifier);
  if (!isNaN(parsed) && String(parsed) === appIdentifier.trim()) {
    return parsed;
  }

  // Search by name
  const apps = await getApplicationsList();
  const searchName = appIdentifier.toLowerCase().trim();

  // Try exact match first
  const exact = apps.find(
    (a) => a.name.toLowerCase() === searchName
  );
  if (exact) return exact.id;

  // Try contains match
  const partial = apps.filter((a) =>
    a.name.toLowerCase().includes(searchName)
  );

  if (partial.length === 1) {
    return partial[0]!.id;
  }

  if (partial.length > 1) {
    const names = partial.map((a) => `  - ${a.name} (ID: ${a.id})`).join("\n");
    throw new Error(
      `Multiple applications match "${appIdentifier}":\n${names}\nPlease be more specific or use the numeric ID.`
    );
  }

  throw new Error(
    `No application found matching "${appIdentifier}". Use the appd_get_applications tool to see all available applications.`
  );
}

/**
 * Resolve a numeric application ID to its name string.
 * Returns the numeric ID as a string fallback if name cannot be found.
 */
export async function resolveAppName(appId: number): Promise<string> {
  const apps = await getApplicationsList();
  return apps.find((a) => a.id === appId)?.name ?? String(appId);
}

/**
 * Invalidate the cached applications list.
 */
export function clearAppCache(): void {
  cachedApps = null;
  cacheTimestamp = 0;
}
