/**
 * Tool: appd_get_health_violations
 * Retrieve health rule violations for one or all applications.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { appdGet } from "../services/api-client.js";
import { resolveAppId } from "../utils/app-resolver.js";
import { handleError, textResponse, isAxios404 } from "../utils/error-handler.js";
import { truncateIfNeeded } from "../utils/formatting.js";
import { DEFAULT_VIOLATIONS_DURATION_MINS } from "../constants.js";
import type { AppDApplication, HealthRuleViolation } from "../types.js";

const InputSchema = {
  application: z
    .union([z.string(), z.number()])
    .optional()
    .describe(
      "Application name or numeric ID. If omitted, checks all applications."
    ),
  durationInMins: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Time range in minutes to look back. Defaults to 1440 (24 hours)."
    ),
};

/**
 * Fetch violations for a single application, with fallback endpoints.
 */
async function fetchViolations(
  appId: number,
  duration: number
): Promise<HealthRuleViolation[]> {
  const params = {
    "time-range-type": "BEFORE_NOW",
    "duration-in-mins": duration,
  };

  let data: unknown;
  try {
    data = await appdGet(
      `/controller/rest/applications/${appId}/problems/healthrule-violations`,
      params
    );
  } catch (error) {
    // Fallback to general problems endpoint on 404
    if (isAxios404(error)) {
      data = await appdGet(
        `/controller/rest/applications/${appId}/problems`,
        params
      );
    } else {
      throw error;
    }
  }

  return normalizeViolations(data);
}

/**
 * Handle the many different response shapes AppDynamics can return.
 */
function normalizeViolations(data: unknown): HealthRuleViolation[] {
  if (Array.isArray(data)) return data;

  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.healthRuleViolations))
      return obj.healthRuleViolations;
    if (Array.isArray(obj.violations)) return obj.violations;
    if (Array.isArray(obj.data)) return obj.data;
    if (Array.isArray(obj.problems)) {
      return (obj.problems as Array<Record<string, unknown>>).filter(
        (p) =>
          p.type === "HEALTH_RULE_VIOLATION" ||
          p.triggeredEntityType === "HEALTH_RULE" ||
          (typeof p.name === "string" &&
            p.name.toLowerCase().includes("health"))
      ) as HealthRuleViolation[];
    }
  }

  return [];
}

export function registerHealthViolationTools(server: McpServer): void {
  server.registerTool(
    "appd_get_health_violations",
    {
      title: "Get Health Rule Violations",
      description: `Retrieve health rule violations for a specific application or all applications.

If application is not provided, returns violations across all monitored applications.
Supports application lookup by name or numeric ID.

Args:
  - application (string|number, optional): App name or ID. Omit for all apps.
  - durationInMins (number, optional): Lookback window in minutes (default: 1440 = 24h)

Returns: Array of health rule violations with severity, status, affected entity, and timestamps.`,
      inputSchema: InputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ application, durationInMins }) => {
      try {
        const duration =
          durationInMins ?? DEFAULT_VIOLATIONS_DURATION_MINS;

        if (application !== undefined) {
          const appId = await resolveAppId(application);
          const violations = await fetchViolations(appId, duration);
          return textResponse(truncateIfNeeded(violations));
        }

        // All applications
        const apps = await appdGet<AppDApplication[]>(
          "/controller/rest/applications"
        );

        const results = await Promise.all(
          apps.map(async (app) => {
            try {
              const violations = await fetchViolations(app.id, duration);
              if (violations.length > 0) {
                return {
                  applicationId: app.id,
                  applicationName: app.name,
                  violations,
                };
              }
            } catch (error) {
              if (!isAxios404(error)) {
                console.error(
                  `Error fetching violations for app ID ${app.id}:`,
                  error instanceof Error ? error.message : "unknown error"
                );
              }
            }
            return null;
          })
        );

        const allViolations = results.filter(
          (r): r is NonNullable<typeof r> => r !== null
        );
        return textResponse(truncateIfNeeded(allViolations));
      } catch (error) {
        return handleError(error);
      }
    }
  );
}
