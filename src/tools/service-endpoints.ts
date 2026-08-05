/**
 * Tools: appd_get_service_endpoints, appd_get_service_endpoint_performance
 * List service endpoints and get their performance metrics.
 *
 * Both tools work through the metric tree. The REST configuration endpoints for
 * service endpoints return "400 Unsupported URI" on SaaS controllers — see
 * service-endpoint-paths.ts for the full list of what was tried.
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
import type { MetricData } from "../types.js";
import {
  SEP_METRICS,
  describeEndpoints,
  matchServiceEndpoints,
  parseMetricTreeNodes,
  sepMetricPath,
  sepNamesFromTree,
  sepTierPath,
  type ServiceEndpointRef,
} from "./service-endpoint-paths.js";

const ListSchema = {
  application: z
    .union([z.string(), z.number()])
    .describe("Application name or numeric ID."),
  tierFilter: z
    .string()
    .optional()
    .describe("Optional: filter by tier name (case-insensitive substring)."),
};

const PerfSchema = {
  application: z
    .union([z.string(), z.number()])
    .describe("Application name or numeric ID."),
  serviceEndpoint: z
    .string()
    .describe(
      "Service endpoint name, e.g. '/http/to2nd'. Use appd_get_service_endpoints to discover names. Matched case-insensitively, exact match preferred."
    ),
  tier: z
    .string()
    .optional()
    .describe(
      "Tier name, required only to disambiguate an endpoint that exists on more than one tier."
    ),
  ...TimeRangeSchema,
};

/** Result of walking the metric tree for one application. */
interface SepListing {
  endpoints: ServiceEndpointRef[];
  warnings: string[];
}

/**
 * Enumerate service endpoints by walking `Service Endpoints|<tier>` per tier.
 *
 * Tier failures are collected rather than swallowed: an endpoint list that is
 * empty because every request failed must not look like an application that
 * genuinely has no service endpoints.
 */
async function listServiceEndpoints(
  appId: number,
  tierFilter?: string | undefined
): Promise<SepListing> {
  const tiers = await appdGet<Array<{ id: number; name: string }>>(
    `/controller/rest/applications/${appId}/tiers`
  );

  const filter = tierFilter?.toLowerCase().trim();
  const scoped = filter
    ? tiers.filter((t) => t.name.toLowerCase().includes(filter))
    : tiers;

  const warnings: string[] = [];

  const perTier = await mapWithConcurrency(scoped, async (tier) => {
    try {
      const data = await appdGet(
        `/controller/rest/applications/${appId}/metrics`,
        { "metric-path": sepTierPath(tier.name) }
      );
      return sepNamesFromTree(parseMetricTreeNodes(data)).map((name) => ({
        name,
        tierName: tier.name,
      }));
    } catch (error) {
      warnings.push(
        `Could not list service endpoints for tier "${tier.name}": ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return [] as ServiceEndpointRef[];
    }
  });

  return { endpoints: perTier.flat(), warnings };
}

export function registerServiceEndpointTools(server: McpServer): void {
  server.registerTool(
    "appd_get_service_endpoints",
    {
      title: "List Service Endpoints",
      description: `List service endpoints (SEPs) for an application.

Service endpoints represent individual API endpoints or servlet mappings within your application tiers. They provide more granular performance data than business transactions — you can see which specific URL paths or service methods are slow.

Discovered by walking the metric tree ('Service Endpoints|{tier}|{endpoint}'), because the REST configuration endpoints for SEPs are not supported on SaaS controllers. One consequence: only endpoints that have reported metrics are listed. A configured-but-idle endpoint will not appear.

Args:
  - application (string|number): App name or ID
  - tierFilter (string, optional): Filter by tier name (case-insensitive substring)

Returns: { serviceEndpoints: [{ name, tierName }], warnings? } — pass name (and tier, if the name repeats across tiers) to appd_get_service_endpoint_performance.`,
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
        const { endpoints, warnings } = await listServiceEndpoints(
          appId,
          tierFilter
        );

        return textResponse(
          truncateIfNeeded({
            serviceEndpoints: endpoints,
            ...(warnings.length > 0 && { warnings }),
          })
        );
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

Retrieves average response time, calls per minute, and errors per minute.

Identify the endpoint by NAME (e.g. '/http/to2nd'), not by numeric id — service
endpoint metrics are addressed by tier and name in the metric tree. Use
appd_get_service_endpoints to discover names.

Time range: omit all time arguments for the last hour, or specify an exact
historical window with startTime + endTime (ISO 8601 or epoch ms). Note that a
narrow recent window returns nothing for an endpoint with no recent traffic —
widen the window before concluding the endpoint is broken.

Args:
  - application (string|number): App name or ID
  - serviceEndpoint (string): Endpoint name, e.g. '/http/to2nd'
  - tier (string, optional): Tier name, to disambiguate a name used on several tiers
  - durationInMins (number, optional): Window length in minutes (default: 60)
  - startTime (string|number, optional): Window start — ISO 8601 or epoch ms
  - endTime (string|number, optional): Window end — ISO 8601 or epoch ms

Returns: Metrics for the endpoint, plus a warnings array if any metric could not be fetched.`,
      inputSchema: PerfSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({
      application,
      serviceEndpoint,
      tier,
      durationInMins,
      startTime,
      endTime,
    }) => {
      try {
        const appId = await resolveAppId(application);
        const range = resolveTimeRange(
          { durationInMins, startTime, endTime },
          DEFAULT_DURATION_MINS
        );

        const { endpoints, warnings } = await listServiceEndpoints(appId, tier);
        const matches = matchServiceEndpoints(endpoints, serviceEndpoint, tier);

        if (matches.length === 0) {
          const available =
            endpoints.length > 0
              ? `\n\nAvailable service endpoints:\n${describeEndpoints(endpoints)}`
              : "\n\nNo service endpoints reported metrics for this application.";
          return handleError(
            new Error(
              `No service endpoint matching "${serviceEndpoint}"${
                tier ? ` on tier "${tier}"` : ""
              }.${available}`
            )
          );
        }

        if (matches.length > 1) {
          return handleError(
            new Error(
              `"${serviceEndpoint}" matches ${matches.length} service endpoints:\n${describeEndpoints(
                matches
              )}\nPass the exact name, and tier to disambiguate.`
            )
          );
        }

        const target = matches[0]!;
        const metricWarnings = [...warnings];

        // Three fixed metrics — already within MAX_CONCURRENT_REQUESTS.
        const metricResults = await Promise.all(
          SEP_METRICS.map(async (metric) => {
            const path = sepMetricPath(target.tierName, target.name, metric);
            try {
              const data = await appdGet<MetricData[]>(
                `/controller/rest/applications/${appId}/metric-data`,
                { "metric-path": path, ...range.params }
              );
              return { metric, data: data[0] ?? null };
            } catch (error) {
              metricWarnings.push(
                `Failed to fetch "${metric}": ${
                  error instanceof Error ? error.message : String(error)
                }`
              );
              return { metric, data: null };
            }
          })
        );

        const metrics: Record<string, unknown> = {};
        const noData: string[] = [];
        for (const { metric, data } of metricResults) {
          if (data) metrics[metric] = data;
          else noData.push(metric);
        }

        return textResponse(
          truncateIfNeeded({
            serviceEndpoint: target.name,
            tierName: target.tierName,
            timeRange: range.description,
            metrics,
            ...(noData.length > 0 && { noDataFor: noData }),
            ...(metricWarnings.length > 0 && { warnings: metricWarnings }),
          })
        );
      } catch (error) {
        return handleError(error);
      }
    }
  );
}
