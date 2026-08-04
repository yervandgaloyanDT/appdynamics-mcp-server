/**
 * Tool: appd_get_anomalies
 * Retrieve anomaly detection events for applications.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { appdGet } from "../services/api-client.js";
import { resolveAppId } from "../utils/app-resolver.js";
import { handleError, textResponse } from "../utils/error-handler.js";
import { truncateIfNeeded } from "../utils/formatting.js";
import { mapWithConcurrency } from "../utils/concurrency.js";
import { TimeRangeSchema, resolveTimeRange } from "../utils/time-range.js";
import {
  DEFAULT_ANOMALY_DURATION_MINS,
  DEFAULT_ANOMALY_SEVERITIES,
  ANOMALY_EVENT_TYPES,
} from "../constants.js";
import type { AppDApplication, AppDEvent } from "../types.js";

const InputSchema = {
  application: z
    .union([z.string(), z.number()])
    .optional()
    .describe(
      "Application name or numeric ID. If omitted, checks all applications."
    ),
  ...TimeRangeSchema,
  severities: z
    .string()
    .optional()
    .describe(
      "Comma-separated severity levels. Defaults to 'INFO,WARN,ERROR'."
    ),
  includeAll: z
    .boolean()
    .optional()
    .describe(
      "If true, includes all events (opens, closes, upgrades, downgrades). If false (default), only shows currently open anomalies."
    ),
};

/**
 * Fetch anomaly events for a single app and optionally filter to only open ones.
 */
async function fetchAnomalies(
  appId: number,
  timeParams: Record<string, string | number>,
  severities: string,
  includeAll: boolean
): Promise<AppDEvent[]> {
  const rawEvents = await appdGet<AppDEvent[]>(
    `/controller/rest/applications/${appId}/events`,
    {
      ...timeParams,
      "event-types": ANOMALY_EVENT_TYPES,
      severities,
    }
  );

  const events = Array.isArray(rawEvents) ? rawEvents : [];

  if (includeAll || events.length === 0) {
    return events;
  }

  // Filter to only currently open anomalies
  const anomalyMap = new Map<string, AppDEvent[]>();

  for (const event of events) {
    const key = `${event.affectedEntityType || ""}-${event.affectedEntityId || ""}-${event.affectedEntityName || ""}`;
    if (!anomalyMap.has(key)) {
      anomalyMap.set(key, []);
    }
    anomalyMap.get(key)!.push(event);
  }

  const openAnomalies: AppDEvent[] = [];
  for (const [, anomalyEvents] of anomalyMap.entries()) {
    anomalyEvents.sort((a, b) => (b.eventTime || 0) - (a.eventTime || 0));
    const mostRecent = anomalyEvents[0]!;
    if (mostRecent.type && !mostRecent.type.includes("CLOSE")) {
      openAnomalies.push(mostRecent);
    }
  }

  return openAnomalies;
}

export function registerAnomalyTools(server: McpServer): void {
  server.registerTool(
    "appd_get_anomalies",
    {
      title: "Get Anomaly Events",
      description: `Retrieve anomaly detection events for a specific application or all applications. By default, returns only currently open anomalies.

Set includeAll to true to see all events including closed ones.

Time range: omit all time arguments for the last 24 hours, or specify an exact
historical window with startTime + endTime (ISO 8601 or epoch ms).

Args:
  - application (string|number, optional): App name or ID. Omit for all apps.
  - durationInMins (number, optional): Window length in minutes (default: 1440 = 24h)
  - startTime (string|number, optional): Window start — ISO 8601 or epoch ms
  - endTime (string|number, optional): Window end — ISO 8601 or epoch ms
  - severities (string, optional): Comma-separated severity levels (default: 'INFO,WARN,ERROR')
  - includeAll (boolean, optional): If true, includes all events including closed anomalies

Returns: Array of anomaly events. When querying all apps, results are grouped by application.`,
      inputSchema: InputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ application, durationInMins, startTime, endTime, severities, includeAll }) => {
      try {
        const range = resolveTimeRange(
          { durationInMins, startTime, endTime },
          DEFAULT_ANOMALY_DURATION_MINS
        );
        const sevs = severities ?? DEFAULT_ANOMALY_SEVERITIES;
        const showAll = includeAll ?? false;

        if (application !== undefined) {
          const appId = await resolveAppId(application);
          const events = await fetchAnomalies(appId, range.params, sevs, showAll);
          return textResponse(truncateIfNeeded(events));
        }

        // All applications — bounded concurrency to avoid tripping rate limits.
        const apps = await appdGet<AppDApplication[]>(
          "/controller/rest/applications"
        );

        const results = await mapWithConcurrency(apps, async (app) => {
          try {
            const events = await fetchAnomalies(app.id, range.params, sevs, showAll);
            if (events.length > 0) {
              return {
                applicationId: app.id,
                applicationName: app.name,
                anomalies: events,
              };
            }
          } catch {
            // Skip apps that fail
          }
          return null;
        });

        const allAnomalies = results.filter(
          (r): r is NonNullable<typeof r> => r !== null
        );
        return textResponse(truncateIfNeeded(allAnomalies));
      } catch (error) {
        return handleError(error);
      }
    }
  );
}
