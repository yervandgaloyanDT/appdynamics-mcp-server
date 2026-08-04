/**
 * Tool: appd_get_snapshots
 * Retrieve transaction snapshots for an application.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { appdGet } from "../services/api-client.js";
import { resolveAppId } from "../utils/app-resolver.js";
import { handleError, textResponse } from "../utils/error-handler.js";
import { truncateIfNeeded } from "../utils/formatting.js";
import { TimeRangeSchema, resolveTimeRange } from "../utils/time-range.js";
import {
  DEFAULT_SNAPSHOT_DURATION_MINS,
  DEFAULT_MAX_SNAPSHOTS,
} from "../constants.js";

const InputSchema = {
  application: z
    .union([z.string(), z.number()])
    .describe("Application name or numeric ID."),
  ...TimeRangeSchema,
  guids: z
    .string()
    .optional()
    .describe("Comma-separated request GUIDs to retrieve specific snapshots."),
  dataCollectorName: z
    .string()
    .optional()
    .describe("Filter by data collector name."),
  dataCollectorType: z
    .string()
    .optional()
    .describe("Filter by data collector type."),
  dataCollectorValue: z
    .string()
    .optional()
    .describe("Filter by data collector value."),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum number of snapshots to return. Defaults to 20."),
};

export function registerSnapshotTools(server: McpServer): void {
  server.registerTool(
    "appd_get_snapshots",
    {
      title: "Get Transaction Snapshots",
      description: `Retrieve transaction snapshots (slow, error, stall) for an application.

Snapshots are deep diagnostic captures of individual requests. They show call graphs, SQL queries, HTTP calls, and more for requests that were slow, errored, or stalled.

Time range: omit all time arguments for the last 30 minutes, or specify an exact
historical window with startTime + endTime (ISO 8601 or epoch ms) — useful for
pulling the snapshots captured during a past incident.

Args:
  - application (string|number): App name or ID
  - durationInMins (number, optional): Window length in minutes (default: 30)
  - startTime (string|number, optional): Window start — ISO 8601 or epoch ms
  - endTime (string|number, optional): Window end — ISO 8601 or epoch ms
  - guids (string, optional): Specific snapshot GUIDs
  - dataCollectorName/Type/Value (string, optional): Data collector filters
  - maxResults (number, optional): Max snapshots to return (default: 20, max: 100)

Returns: Array of snapshot objects with timing, error details, and diagnostic info.`,
      inputSchema: InputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({
      application,
      durationInMins,
      startTime,
      endTime,
      guids,
      dataCollectorName,
      dataCollectorType,
      dataCollectorValue,
      maxResults,
    }) => {
      try {
        const appId = await resolveAppId(application);
        const range = resolveTimeRange(
          { durationInMins, startTime, endTime },
          DEFAULT_SNAPSHOT_DURATION_MINS
        );

        const params: Record<string, string | number | boolean | undefined> = {
          ...range.params,
          "maximum-results": maxResults ?? DEFAULT_MAX_SNAPSHOTS,
        };

        if (guids) params["guids"] = guids;
        if (dataCollectorName) params["data-collector-name"] = dataCollectorName;
        if (dataCollectorType) params["data-collector-type"] = dataCollectorType;
        if (dataCollectorValue) params["data-collector-value"] = dataCollectorValue;

        const data = await appdGet(
          `/controller/rest/applications/${appId}/request-snapshots`,
          params
        );

        return textResponse(truncateIfNeeded(data));
      } catch (error) {
        return handleError(error);
      }
    }
  );
}
