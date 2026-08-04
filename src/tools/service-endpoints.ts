/**
 * Tools: appd_get_service_endpoints, appd_get_service_endpoint_performance
 * List service endpoints and get their performance metrics.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { appdGet } from "../services/api-client.js";
import { resolveAppId } from "../utils/app-resolver.js";
import { handleError, textResponse } from "../utils/error-handler.js";
import { truncateIfNeeded } from "../utils/formatting.js";
import { mapWithConcurrency } from "../utils/concurrency.js";
import { TimeRangeSchema, resolveTimeRange } from "../utils/time-range.js";
import { DEFAULT_DURATION_MINS } from "../constants.js";
import type { ServiceEndpoint, MetricData } from "../types.js";

const ListSchema = {
  application: z
    .union([z.string(), z.number()])
    .describe("Application name or numeric ID."),
  tierFilter: z
    .string()
    .optional()
    .describe("Optional: filter by tier name (case-insensitive)."),
};

const PerfSchema = {
  application: z
    .union([z.string(), z.number()])
    .describe("Application name or numeric ID."),
  sepId: z.number().int().describe("Service endpoint ID."),
  ...TimeRangeSchema,
};

export function registerServiceEndpointTools(server: McpServer): void {
  server.registerTool(
    "appd_get_service_endpoints",
    {
      title: "List Service Endpoints",
      description: `List service endpoints (SEPs) for an application.

Service endpoints represent individual API endpoints or servlet mappings within your application tiers. They provide more granular performance data than business transactions — you can see which specific URL paths or service methods are slow.

Args:
  - application (string|number): App name or ID
  - tierFilter (string, optional): Filter by tier name

Returns: Array of service endpoints with id, name, tier info, and type.`,
      inputSchema: ListSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ application, tierFilter }) => {
      try {
        const appId = await resolveAppId(application);

        // Service endpoints are per-tier, so we need to fetch tiers first
        const tiers = await appdGet<Array<{ id: number; name: string }>>(
          `/controller/rest/applications/${appId}/tiers`
        );

        let filteredTiers = tiers;
        if (tierFilter) {
          const filter = tierFilter.toLowerCase();
          filteredTiers = tiers.filter((t) =>
            t.name.toLowerCase().includes(filter)
          );
        }

        // Fetch SEPs for all tiers, bounded so wide apps don't trip rate limits.
        const results = await mapWithConcurrency(filteredTiers, async (tier) => {
          try {
            const seps = await appdGet<ServiceEndpoint[]>(
              `/controller/rest/applications/${appId}/tiers/${tier.id}/service-endpoints`
            );
            return seps.map((sep) => ({
              id: sep.id,
              name: sep.name,
              tierName: tier.name,
              tierId: tier.id,
              type: sep.sepType ?? "unknown",
            }));
          } catch {
            return [];
          }
        });

        const allSeps = results.flat();
        return textResponse(truncateIfNeeded(allSeps));
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // ── appd_get_service_endpoint_performance ────────────────────────────────

  server.registerTool(
    "appd_get_service_endpoint_performance",
    {
      title: "Get Service Endpoint Performance",
      description: `Get performance metrics for a specific service endpoint.

Retrieves average response time, calls per minute, and errors per minute for the specified service endpoint.

Use appd_get_service_endpoints first to find the SEP ID.

Time range: omit all time arguments for the last hour, or specify an exact
historical window with startTime + endTime (ISO 8601 or epoch ms).

Args:
  - application (string|number): App name or ID
  - sepId (number): Service endpoint ID
  - durationInMins (number, optional): Window length in minutes (default: 60)
  - startTime (string|number, optional): Window start — ISO 8601 or epoch ms
  - endTime (string|number, optional): Window end — ISO 8601 or epoch ms

Returns: Performance metrics for the service endpoint.`,
      inputSchema: PerfSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ application, sepId, durationInMins, startTime, endTime }) => {
      try {
        const appId = await resolveAppId(application);
        const range = resolveTimeRange(
          { durationInMins, startTime, endTime },
          DEFAULT_DURATION_MINS
        );

        const metrics = [
          "Average Response Time (ms)",
          "Calls per Minute",
          "Errors per Minute",
        ];

        const metricPromises = metrics.map((metric) =>
          appdGet<MetricData[]>(
            `/controller/rest/applications/${appId}/metric-data`,
            {
              "metric-path": `Service Endpoints|${sepId}|${metric}`,
              ...range.params,
            }
          )
            .then((data) => ({ metric, data: data[0] ?? null }))
            .catch(() => ({ metric, data: null }))
        );

        const metricResults = await Promise.all(metricPromises);

        const results: Record<string, unknown> = {
          serviceEndpointId: sepId,
          timeRange: range.description,
        };

        for (const result of metricResults) {
          if (result.data) {
            results[result.metric] = result.data;
          }
        }

        return textResponse(JSON.stringify(results, null, 2));
      } catch (error) {
        return handleError(error);
      }
    }
  );
}
