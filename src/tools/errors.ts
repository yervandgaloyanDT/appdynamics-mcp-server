/**
 * Tool: appd_get_errors
 * Retrieve error and exception events for an application.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { appdGet } from "../services/api-client.js";
import { resolveAppId } from "../utils/app-resolver.js";
import { handleError, textResponse } from "../utils/error-handler.js";
import { truncateIfNeeded } from "../utils/formatting.js";
import { TimeRangeSchema, resolveTimeRange } from "../utils/time-range.js";
import {
  DEFAULT_DURATION_MINS,
  ERROR_EVENT_TYPES,
  ERROR_SEVERITIES,
} from "../constants.js";

const InputSchema = {
  application: z
    .union([z.string(), z.number()])
    .describe("Application name or numeric ID."),
  ...TimeRangeSchema,
};

export function registerErrorTools(server: McpServer): void {
  server.registerTool(
    "appd_get_errors",
    {
      title: "Get Error Events",
      description: `Retrieve error and exception events for an application.

Returns ERROR, APPLICATION_ERROR, and APPLICATION_CRASH events from the AppDynamics events API. These represent exceptions, application errors, and crashes detected by the agent.

Time range: omit all time arguments for the last hour, or specify an exact
historical window with startTime + endTime (ISO 8601 or epoch ms).

Args:
  - application (string|number): App name or ID
  - durationInMins (number, optional): Window length in minutes (default: 60)
  - startTime (string|number, optional): Window start — ISO 8601 or epoch ms
  - endTime (string|number, optional): Window end — ISO 8601 or epoch ms

Returns: Array of error events with severity, summary, timestamp, and affected entity details.`,
      inputSchema: InputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ application, durationInMins, startTime, endTime }) => {
      try {
        const appId = await resolveAppId(application);
        const range = resolveTimeRange(
          { durationInMins, startTime, endTime },
          DEFAULT_DURATION_MINS
        );

        const data = await appdGet(
          `/controller/rest/applications/${appId}/events`,
          {
            ...range.params,
            "event-types": ERROR_EVENT_TYPES,
            severities: ERROR_SEVERITIES,
          }
        );

        return textResponse(truncateIfNeeded(data));
      } catch (error) {
        return handleError(error);
      }
    }
  );
}
