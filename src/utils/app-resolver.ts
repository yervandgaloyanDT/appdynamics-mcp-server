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

/** Shared in-flight fetch, so concurrent tools issue one request, not N. */
let inFlight: Promise<AppDApplication[]> | null = null;

/**
 * Fetch and cache the list of all applications.
 *
 * Tools frequently resolve an application name at the same moment (a fan-out
 * across apps, or several tool calls in one turn). Without the in-flight share
 * each of those would fire its own /rest/applications request on a cold cache.
 */
async function getApplicationsList(): Promise<AppDApplication[]> {
  if (cachedApps && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedApps;
  }
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const apps = await appdGet<AppDApplication[]>(
        "/controller/rest/applications"
      );
      cachedApps = apps;
      cacheTimestamp = Date.now();
      return apps;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * Look an application up directly by name or id.
 *
 * `/rest/applications/{nameOrId}` resolves both forms and — unlike the list
 * endpoint — covers applications that never appear in /rest/applications
 * (SIM and other special application types). A miss returns HTTP 400, not 404.
 */
async function lookupApplicationDirect(
  nameOrId: string | number
): Promise<AppDApplication | null> {
  try {
    const result = await appdGet<AppDApplication[]>(
      `/controller/rest/applications/${encodeURIComponent(String(nameOrId))}`
    );
    const found = Array.isArray(result) ? result[0] : undefined;
    return found?.id !== undefined ? found : null;
  } catch {
    return null;
  }
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

  // Not in the list — it may still exist. SIM and other special application
  // types are absent from /rest/applications but resolve by name directly.
  const direct = await lookupApplicationDirect(appIdentifier);
  if (direct) return direct.id;

  throw new Error(
    `No application found matching "${appIdentifier}". Use the appd_get_applications tool to see all available applications.`
  );
}

/**
 * Resolve a numeric application ID to its name string.
 * Falls back to a direct per-app API call (handles SIM and other special apps
 * that don't appear in the standard /rest/applications list).
 * Returns the numeric ID as a string only if all lookups fail.
 */
export async function resolveAppName(appId: number): Promise<string> {
  const apps = await getApplicationsList();
  const found = apps.find((a) => a.id === appId);
  if (found) return found.name;

  // Fallback: direct per-app endpoint (covers SIM and special application types)
  const direct = await lookupApplicationDirect(appId);
  if (direct?.name) return direct.name;

  return String(appId);
}
