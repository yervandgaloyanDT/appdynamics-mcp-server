/**
 * Tool: appd_diagnose_issue
 * Composite root cause analysis — fetches violations, anomalies, error events,
 * and snapshots in parallel, then correlates them into a structured diagnostic report.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { appdGet } from "../services/api-client.js";
import { resolveAppId } from "../utils/app-resolver.js";
import { handleError, textResponse, isAxios404 } from "../utils/error-handler.js";
import { truncateIfNeeded } from "../utils/formatting.js";
import {
  TimeRangeSchema,
  resolveTimeRange,
  precedingWindow,
} from "../utils/time-range.js";
import {
  DEFAULT_DURATION_MINS,
  DIAG_ERROR_EVENT_TYPES,
  DIAG_ANOMALY_EVENT_TYPES,
  DIAG_EVENT_SEVERITIES,
  BASELINE_DEGRADATION_PCT,
  BASELINE_MIN_RESPONSE_MS,
  BASELINE_MIN_ERRORS_PER_MIN,
  DIAG_MAX_TIERS_PHASE2,
  DIAG_MAX_BACKENDS_PHASE2,
  DIAG_MAX_NODES_PER_TIER_PHASE2,
} from "../constants.js";
import type {
  HealthRuleViolation,
  AppDEvent,
  BusinessTransaction,
  Tier,
  AppDNode,
  Backend,
  TierMetricSummary,
  BackendMetricSummary,
  InfraNodeSummary,
} from "../types.js";
import {
  applyMetricBoosts,
  buildCausalityChain,
  buildInvestigationSteps,
  buildSummary,
  buildTimeline,
  collectAffectedEntities,
  computeChangePct,
  correlate,
  estimateIssueStart,
  extractErrorMessage,
  extractMetricAverage,
  normalizeViolations,
  rankCandidates,
  sortErrorBreakdown,
  summarizeSnapshot,
} from "./root-cause-analysis.js";

// ── Helpers ──────────────────────────────────────────────────────────────────
// Correlation, scoring and narration live in root-cause-analysis.ts (pure, tested).
// What remains here is the fetching and the assembly of the two together.

/**
 * Fetches a single metric over the supplied time-range parameters.
 * 404s are silently ignored (metric not instrumented).
 */
async function fetchMetricSafe(
  appId: number,
  metricPath: string,
  timeParams: Record<string, string | number>,
  warnings: string[],
): Promise<number | null> {
  try {
    const params = { "metric-path": metricPath, ...timeParams };
    const data = await appdGet(`/controller/rest/applications/${appId}/metric-data`, params);
    return extractMetricAverage(data);
  } catch (err) {
    if (!isAxios404(err)) warnings.push(`Metric '${metricPath}': ${extractErrorMessage(err)}`);
    return null;
  }
}

// ── Input Schema ─────────────────────────────────────────────────────────────

const InputSchema = {
  application: z
    .union([z.string(), z.number()])
    .describe("Application name or numeric ID."),
  ...TimeRangeSchema,
  focus: z
    .enum(["all", "performance", "errors", "availability"])
    .optional()
    .describe(
      "Narrow the diagnosis focus. " +
        "'performance' = slow/stall events + snapshots + anomalies; " +
        "'errors' = error events + crash events + snapshots; " +
        "'availability' = health violations + anomalies; " +
        "'all' (default) = everything."
    ),
};

// ── Tool Registration ────────────────────────────────────────────────────────

export function registerRootCauseTools(server: McpServer): void {
  server.registerTool(
    "appd_diagnose_issue",
    {
      title: "Diagnose Issue (Root Cause Analysis)",
      description: `Perform a two-phase automated root cause analysis for an application.

Phase 1 (topology): Fetches health violations, anomalies, error events, transaction snapshots, business transactions, tiers, nodes, and backends in parallel — correlating them into ranked root cause candidates.

Phase 2 (metrics with baseline): For each affected tier, backend, and node, fetches metrics for BOTH the current window AND a prior equivalent baseline window. Anomaly flags (isSlow, isCpuSaturated, hasGcPressure) are computed as percentage degradation vs baseline — no hardcoded absolute thresholds. Example: a backend normally at 50ms now at 600ms is flagged (+1100%); one normally at 2000ms now at 2100ms is not (+5%).

Use this when you need to quickly understand *why* an application is behaving badly without manually calling many separate tools.

Time range: omit all time arguments to analyse the last hour. To investigate a
past incident, pass startTime + endTime (ISO 8601 or epoch ms) — the baseline
window automatically becomes the equivalent window immediately before it, so
degradation is measured against normal behaviour leading into the incident.

Args:
  - application (string|number): App name or numeric ID
  - durationInMins (number, optional): Window length in minutes (default: 60)
  - startTime (string|number, optional): Window start — ISO 8601 or epoch ms
  - endTime (string|number, optional): Window end — ISO 8601 or epoch ms
  - focus (string, optional): Narrow diagnosis to 'performance', 'errors', 'availability', or 'all' (default)

Returns: A structured diagnostic report with summary, causalityChain (ordered root→effect), tierMetrics, backendAnalysis, infrastructureInsights (all with baseline comparison), ranked root cause candidates, timeline, error breakdown, sample snapshots (with sqlQueries/httpCalls/errorStackTrace), and metric-aware investigation steps.`,
      inputSchema: InputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ application, durationInMins, startTime, endTime, focus }) => {
      try {
        const appId = await resolveAppId(application);
        const range = resolveTimeRange(
          { durationInMins, startTime, endTime },
          DEFAULT_DURATION_MINS
        );
        const focusMode = focus ?? "all";

        const timeParams = range.params;

        // ── Parallel Fetches ───────────────────────────────────────────────

        const wantViolations =
          focusMode === "all" || focusMode === "availability";
        const wantErrorEvents =
          focusMode === "all" ||
          focusMode === "errors" ||
          focusMode === "performance";
        const wantAnomalies =
          focusMode === "all" ||
          focusMode === "availability" ||
          focusMode === "performance";
        const wantSnapshots =
          focusMode === "all" ||
          focusMode === "errors" ||
          focusMode === "performance";
        const wantBTs = focusMode === "all" || focusMode === "performance";

        const [
          violationsResult,
          errorEventsResult,
          anomalyEventsResult,
          snapshotsResult,
          btsResult,
          tiersResult,
          nodesResult,
          backendsResult,
        ] = await Promise.allSettled([
          // 1. Health rule violations (with fallback endpoint)
          wantViolations
            ? (async (): Promise<HealthRuleViolation[]> => {
                let data: unknown;
                try {
                  data = await appdGet(
                    `/controller/rest/applications/${appId}/problems/healthrule-violations`,
                    timeParams
                  );
                } catch (err) {
                  if (isAxios404(err)) {
                    data = await appdGet(
                      `/controller/rest/applications/${appId}/problems`,
                      timeParams
                    );
                  } else {
                    throw err;
                  }
                }
                return normalizeViolations(data);
              })()
            : Promise.resolve([] as HealthRuleViolation[]),

          // 2. Infrastructure & error events
          wantErrorEvents
            ? appdGet<AppDEvent[]>(
                `/controller/rest/applications/${appId}/events`,
                {
                  ...timeParams,
                  "event-types": DIAG_ERROR_EVENT_TYPES,
                  severities: DIAG_EVENT_SEVERITIES,
                }
              )
            : Promise.resolve([] as AppDEvent[]),

          // 3. ML anomaly events
          wantAnomalies
            ? appdGet<AppDEvent[]>(
                `/controller/rest/applications/${appId}/events`,
                {
                  ...timeParams,
                  "event-types": DIAG_ANOMALY_EVENT_TYPES,
                  severities: "INFO,WARN,ERROR",
                }
              )
            : Promise.resolve([] as AppDEvent[]),

          // 4. Sample snapshots (slow/error transactions)
          wantSnapshots
            ? appdGet(
                `/controller/rest/applications/${appId}/request-snapshots`,
                { ...timeParams, "maximum-results": 10 }
              )
            : Promise.resolve([]),

          // 5. Business transactions (for entity name correlation)
          wantBTs
            ? appdGet<BusinessTransaction[]>(
                `/controller/rest/applications/${appId}/business-transactions`
              )
            : Promise.resolve([] as BusinessTransaction[]),

          // 6. Tiers
          appdGet<Tier[]>(`/controller/rest/applications/${appId}/tiers`),

          // 7. Nodes
          appdGet<AppDNode[]>(`/controller/rest/applications/${appId}/nodes`),

          // 8. Backends
          appdGet<Backend[]>(`/controller/rest/applications/${appId}/backends`),
        ]);

        // ── Unwrap results & collect data-fetch warnings ───────────────────

        const dataFetchWarnings: string[] = [];

        const violations: HealthRuleViolation[] =
          violationsResult.status === "fulfilled"
            ? violationsResult.value
            : (dataFetchWarnings.push(
                `Health violations: ${extractErrorMessage(violationsResult.reason)}`
              ),
              []);

        const errorEvents: AppDEvent[] =
          errorEventsResult.status === "fulfilled"
            ? Array.isArray(errorEventsResult.value)
              ? errorEventsResult.value
              : []
            : (dataFetchWarnings.push(
                `Error events: ${extractErrorMessage(errorEventsResult.reason)}`
              ),
              []);

        const anomalyEvents: AppDEvent[] =
          anomalyEventsResult.status === "fulfilled"
            ? Array.isArray(anomalyEventsResult.value)
              ? anomalyEventsResult.value
              : []
            : (dataFetchWarnings.push(
                `Anomaly events: ${extractErrorMessage(anomalyEventsResult.reason)}`
              ),
              []);

        const snapshots: unknown[] =
          snapshotsResult.status === "fulfilled"
            ? Array.isArray(snapshotsResult.value)
              ? snapshotsResult.value
              : []
            : (dataFetchWarnings.push(
                `Snapshots: ${extractErrorMessage(snapshotsResult.reason)}`
              ),
              []);

        const bts: BusinessTransaction[] =
          btsResult.status === "fulfilled"
            ? btsResult.value
            : (dataFetchWarnings.push(
                `Business transactions: ${extractErrorMessage(btsResult.reason)}`
              ),
              []);

        const allTiers: Tier[] =
          tiersResult.status === "fulfilled" ? tiersResult.value
          : (dataFetchWarnings.push(`Tiers: ${extractErrorMessage(tiersResult.reason)}`), []);

        const allNodes: AppDNode[] =
          nodesResult.status === "fulfilled" ? nodesResult.value
          : (dataFetchWarnings.push(`Nodes: ${extractErrorMessage(nodesResult.reason)}`), []);

        const allBackends: Backend[] =
          backendsResult.status === "fulfilled" ? backendsResult.value
          : (dataFetchWarnings.push(`Backends: ${extractErrorMessage(backendsResult.reason)}`), []);

        // ── Correlation ────────────────────────────────────────────────────

        const { entities: entityMap, errorGroups } = correlate(
          violations,
          errorEvents,
          anomalyEvents
        );

        // ── Affected entities ──────────────────────────────────────────────
        // (computed before Phase 2 so Phase 2 can prioritize affected tiers)
        const {
          tiers: affectedTiers,
          bts: affectedBTs,
          nodes: affectedNodes,
        } = collectAffectedEntities(entityMap, bts);

        // ── Phase 2: Targeted metric fetches with baseline comparison ─────────
        // For each affected entity, fetches metrics for BOTH the current analysis
        // window and the prior equivalent window (the "baseline").
        // Anomaly flags are computed as % degradation vs baseline — no magic numbers.

        const phase2Warnings: string[] = [];

        // Baseline window: the equivalent window immediately before this one.
        const baselineRange = precedingWindow(range);

        // Select tiers: affected first, fill from all tiers, cap
        const tiersToQuery = [
          ...[...affectedTiers],
          ...allTiers.map(t => t.name).filter(n => !affectedTiers.has(n)),
        ].slice(0, DIAG_MAX_TIERS_PHASE2);

        // Select backends, capped
        const backendsToQuery = allBackends.slice(0, DIAG_MAX_BACKENDS_PHASE2);

        // Build tier→nodes map; top DIAG_MAX_NODES_PER_TIER_PHASE2 per affected tier
        const nodesByTier = new Map<string, AppDNode[]>();
        for (const node of allNodes) {
          const arr = nodesByTier.get(node.tierName) ?? [];
          arr.push(node);
          nodesByTier.set(node.tierName, arr);
        }
        const nodePairs = tiersToQuery
          .filter(t => affectedTiers.has(t))
          .flatMap(tierName =>
            (nodesByTier.get(tierName) ?? [])
              .slice(0, DIAG_MAX_NODES_PER_TIER_PHASE2)
              .map(n => ({ tierName, nodeName: n.name }))
          );

        // Fire all current + baseline metric fetches concurrently
        type P2Entry = { key: string; value: number | null };

        function makeMetricPromises(
          metricPath: string,
          keyPrefix: string,
        ): [Promise<P2Entry>, Promise<P2Entry>] {
          return [
            fetchMetricSafe(appId, metricPath, range.params, phase2Warnings)
              .then(v => ({ key: `${keyPrefix}:cur`, value: v })),
            fetchMetricSafe(appId, metricPath, baselineRange.params, phase2Warnings)
              .then(v => ({ key: `${keyPrefix}:base`, value: v })),
          ];
        }

        const p2Promises: Promise<P2Entry>[] = [
          // Tier metrics (current + baseline)
          ...tiersToQuery.flatMap(t => [
            ...makeMetricPromises(`Overall Application Performance|${t}|Average Response Time (ms)`, `tier:${t}:avgResponseMs`),
            ...makeMetricPromises(`Overall Application Performance|${t}|Errors per Minute`, `tier:${t}:errorsPerMin`),
          ]),
          // Backend metrics (current + baseline)
          ...backendsToQuery.flatMap(b => [
            ...makeMetricPromises(`Backends|${b.name}|Average Response Time (ms)`, `backend:${b.name}:avgResponseMs`),
            ...makeMetricPromises(`Backends|${b.name}|Errors per Minute`, `backend:${b.name}:errorsPerMin`),
          ]),
          // Node infra metrics (current + baseline)
          ...nodePairs.flatMap(({ tierName, nodeName }) => [
            ...makeMetricPromises(
              `Application Infrastructure Performance|${tierName}|Individual Nodes|${nodeName}|Hardware Resources|CPU|%Busy`,
              `node:${tierName}:${nodeName}:cpu`
            ),
            ...makeMetricPromises(
              `Application Infrastructure Performance|${tierName}|Individual Nodes|${nodeName}|JVM|Memory:Heap used (MB)`,
              `node:${tierName}:${nodeName}:heap`
            ),
            ...makeMetricPromises(
              `Application Infrastructure Performance|${tierName}|Individual Nodes|${nodeName}|JVM|Garbage Collection|GC Time Spent Per Min (ms)`,
              `node:${tierName}:${nodeName}:gc`
            ),
          ]),
        ];

        const p2Raw = await Promise.allSettled(p2Promises);
        const p2Map = new Map<string, number | null>();
        for (const r of p2Raw) {
          if (r.status === "fulfilled") p2Map.set(r.value.key, r.value.value);
        }

        function p2Get(prefix: string): { cur: number | null; base: number | null } {
          return { cur: p2Map.get(`${prefix}:cur`) ?? null, base: p2Map.get(`${prefix}:base`) ?? null };
        }

        // ── Assemble TierMetricSummary[] ──────────────────────────────────
        const tierMetrics: TierMetricSummary[] = tiersToQuery.map(t => {
          const rt  = p2Get(`tier:${t}:avgResponseMs`);
          const err = p2Get(`tier:${t}:errorsPerMin`);
          const rtChangePct  = computeChangePct(rt.cur,  rt.base,  BASELINE_MIN_RESPONSE_MS);
          const errChangePct = computeChangePct(err.cur, err.base, BASELINE_MIN_ERRORS_PER_MIN);
          return {
            tierName: t,
            avgResponseMs: rt.cur, baselineAvgResponseMs: rt.base, responseChangePct: rtChangePct,
            errorsPerMin: err.cur, baselineErrorsPerMin: err.base, errorsChangePct: errChangePct,
            isSlowResponse: rtChangePct !== null && rtChangePct > BASELINE_DEGRADATION_PCT,
            hasNewErrors: err.cur !== null && err.cur > 0 &&
              (err.base === null || err.base < BASELINE_MIN_ERRORS_PER_MIN ||
               (errChangePct !== null && errChangePct > BASELINE_DEGRADATION_PCT)),
          };
        });

        // ── Assemble BackendMetricSummary[] (only backends with data) ─────
        const backendAnalysis: BackendMetricSummary[] = backendsToQuery
          .map(b => {
            const rt  = p2Get(`backend:${b.name}:avgResponseMs`);
            const err = p2Get(`backend:${b.name}:errorsPerMin`);
            const rtChangePct = computeChangePct(rt.cur, rt.base, BASELINE_MIN_RESPONSE_MS);
            return {
              name: b.name, type: b.exitPointType,
              avgResponseMs: rt.cur, baselineAvgResponseMs: rt.base, responseChangePct: rtChangePct,
              errorsPerMin: err.cur, baselineErrorsPerMin: err.base,
              isSlow: rtChangePct !== null && rtChangePct > BASELINE_DEGRADATION_PCT,
            };
          })
          .filter(b => b.avgResponseMs !== null || b.errorsPerMin !== null);

        // ── Assemble InfraNodeSummary[] (only nodes with data) ────────────
        const infraInsights: InfraNodeSummary[] = nodePairs
          .map(({ tierName, nodeName }) => {
            const cpu  = p2Get(`node:${tierName}:${nodeName}:cpu`);
            const heap = p2Get(`node:${tierName}:${nodeName}:heap`);
            const gc   = p2Get(`node:${tierName}:${nodeName}:gc`);
            const cpuChangePct  = computeChangePct(cpu.cur,  cpu.base);
            const heapChangePct = computeChangePct(heap.cur, heap.base);
            const gcChangePct   = computeChangePct(gc.cur,   gc.base);
            return {
              tierName, nodeName,
              cpuPercent: cpu.cur,   baselineCpuPercent: cpu.base,   cpuChangePct,
              heapUsedMb: heap.cur,  baselineHeapUsedMb: heap.base,
              gcTimeMs:   gc.cur,    baselineGcTimeMs: gc.base,       gcChangePct,
              isCpuSaturated: cpuChangePct !== null && cpuChangePct > BASELINE_DEGRADATION_PCT,
              isHeapPressure: heapChangePct !== null && heapChangePct > BASELINE_DEGRADATION_PCT,
              hasGcPressure:  gcChangePct   !== null && gcChangePct   > BASELINE_DEGRADATION_PCT,
            };
          })
          .filter(n => n.cpuPercent !== null || n.heapUsedMb !== null || n.gcTimeMs !== null);

        dataFetchWarnings.push(...phase2Warnings);

        // ── Metric-based score boosting ───────────────────────────────────
        applyMetricBoosts(entityMap, tierMetrics, infraInsights);

        // ── Rank root cause candidates ─────────────────────────────────────
        const ranked = rankCandidates(entityMap);

        // ── Build merged timeline ──────────────────────────────────────────
        const trimmedTimeline = buildTimeline(violations, errorEvents, anomalyEvents);

        // ── Issue start estimate ───────────────────────────────────────────
        const issueStartedAround = estimateIssueStart(violations);

        // ── Error breakdown ────────────────────────────────────────────────
        const sortedErrorBreakdown = sortErrorBreakdown(errorGroups);

        // ── Summary string ─────────────────────────────────────────────────
        const summary = buildSummary(
          violations,
          anomalyEvents,
          errorEvents,
          range.description
        );

        // ── Causality chain ────────────────────────────────────────────────
        const causalityChain = buildCausalityChain(
          infraInsights,
          backendAnalysis,
          tierMetrics,
          violations.length > 0 || anomalyEvents.length > 0
        );

        // ── Investigation steps ────────────────────────────────────────────
        const steps = buildInvestigationSteps({
          infraInsights,
          backendAnalysis,
          ranked,
          snapshotCount: snapshots.length,
          affectedBTs,
          errorBreakdown: sortedErrorBreakdown,
          violationCount: violations.length,
          issueStartedAround,
        });

        // ── Summarize snapshots ────────────────────────────────────────────
        const summarizedSnapshots = snapshots.map(summarizeSnapshot);

        // ── Assemble report ────────────────────────────────────────────────
        const report = {
          summary,
          timeWindow: range.description,
          baselineWindow: baselineRange.description,
          ...(issueStartedAround ? { issueStartedAround } : {}),
          ...(dataFetchWarnings.length > 0 ? { dataFetchWarnings } : {}),
          topRootCauseCandidates: ranked,
          ...(causalityChain.length > 0 ? { causalityChain } : {}),
          ...(tierMetrics.some(t => t.avgResponseMs !== null) ? { tierMetrics } : {}),
          ...(backendAnalysis.length > 0 ? { backendAnalysis } : {}),
          ...(infraInsights.length > 0 ? { infrastructureInsights: infraInsights } : {}),
          healthViolations: violations,
          anomalies: anomalyEvents,
          errorBreakdown: sortedErrorBreakdown,
          affectedEntities: {
            tiers: [...affectedTiers],
            businessTransactions: [...affectedBTs],
            nodes: [...affectedNodes],
          },
          timeline: trimmedTimeline,
          diagnosticSnapshots: summarizedSnapshots,
          snapshotNote: summarizedSnapshots.length > 0
            ? "Snapshots include sqlQueries, httpCalls, and errorStackTrace fields. Use appd_get_snapshots for full call graphs."
            : undefined,
          investigationSteps: steps,
        };

        return textResponse(truncateIfNeeded(report));
      } catch (error) {
        return handleError(error);
      }
    }
  );
}
