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
import { truncateIfNeeded, formatTimestamp } from "../utils/formatting.js";
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
  BASELINE_CRITICAL_PCT,
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeViolations(data: unknown): HealthRuleViolation[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.healthRuleViolations)) return obj.healthRuleViolations;
    if (Array.isArray(obj.violations)) return obj.violations;
    if (Array.isArray(obj.data)) return obj.data;
    if (Array.isArray(obj.problems)) {
      return (obj.problems as Array<Record<string, unknown>>).filter(
        (p) =>
          p.type === "HEALTH_RULE_VIOLATION" ||
          p.triggeredEntityType === "HEALTH_RULE" ||
          (typeof p.name === "string" && p.name.toLowerCase().includes("health"))
      ) as HealthRuleViolation[];
    }
  }
  return [];
}

/**
 * Convert a Promise.allSettled rejection reason to a human-readable string
 * suitable for the dataFetchWarnings array.
 */
function extractErrorMessage(reason: unknown): string {
  if (reason instanceof Error) {
    const axiosLike = reason as Error & {
      isAxiosError?: boolean;
      response?: { status: number };
      code?: string;
    };
    if (axiosLike.isAxiosError) {
      const status = axiosLike.response?.status;
      if (status === 401) return "authentication failed (401) — check API client credentials";
      if (status === 403) return "permission denied (403) — check API client permissions";
      if (status === 404) return "endpoint not found (404) — feature may not be enabled";
      if (status === 429) return "rate limit exceeded (429)";
      if (status) return `HTTP error (${status})`;
      if (axiosLike.code === "ECONNABORTED") return "request timed out";
      if (axiosLike.code === "ECONNREFUSED" || axiosLike.code === "ENOTFOUND")
        return "cannot reach controller";
      return `network error: ${reason.message}`;
    }
    return reason.message;
  }
  return String(reason);
}

/**
 * Extract the ~10 diagnostic fields from a raw snapshot object,
 * discarding the 40+ fields that add noise without aiding diagnosis.
 */
function summarizeSnapshot(snap: unknown): Record<string, unknown> {
  if (!snap || typeof snap !== "object") return { raw: snap };
  const s = snap as Record<string, unknown>;
  const result: Record<string, unknown> = {
    requestGUID: s["requestGUID"] ?? s["guid"] ?? undefined,
    businessTransaction: s["businessTransactionId"] ?? s["businessTransaction"] ?? undefined,
    tier: s["applicationComponentName"] ?? s["tierName"] ?? s["tier"] ?? undefined,
    node: s["applicationComponentNodeName"] ?? s["nodeName"] ?? s["node"] ?? undefined,
    responseTimeMs: s["timeTakenInMilliSecs"] ?? s["responseTime"] ?? undefined,
    userExperience: s["userExperience"] ?? undefined,
    errorOccurred: s["errorOccurred"] ?? undefined,
    errorDetails: s["errorDetails"] ?? s["errorMessage"] ?? undefined,
    url: s["url"] ?? s["httpUrl"] ?? undefined,
    startTime: s["serverStartTime"] != null
      ? formatTimestamp(s["serverStartTime"] as number)
      : undefined,
  };

  // sqlQueries — AppDynamics uses several key names across versions
  const sqlCandidates = s["sqlQueries"] ?? s["exitCalls"] ?? s["sqlData"];
  if (Array.isArray(sqlCandidates) && sqlCandidates.length > 0) {
    result["sqlQueries"] = (sqlCandidates as Array<Record<string, unknown>>)
      .slice(0, 5)
      .map(q => ({
        query: q["query"] ?? q["commandText"] ?? q["statement"] ?? String(q).slice(0, 200),
        timeTakenMs: q["timeTakenInMilliSecs"] ?? q["duration"] ?? undefined,
      }));
  }

  // httpCalls — external HTTP exit calls
  const httpCandidates = s["httpCallData"] ?? s["callChain"];
  if (Array.isArray(httpCandidates) && httpCandidates.length > 0) {
    result["httpCalls"] = (httpCandidates as Array<Record<string, unknown>>)
      .slice(0, 5)
      .map(h => ({
        url: h["url"] ?? h["uri"] ?? h["destination"] ?? undefined,
        timeTakenMs: h["timeTakenInMilliSecs"] ?? h["duration"] ?? undefined,
        statusCode: h["statusCode"] ?? h["httpStatusCode"] ?? undefined,
      }));
  }

  // errorStackTrace — first 5 lines
  const stack = s["errorDetails"] ?? s["stackTrace"] ?? s["exception"];
  if (typeof stack === "string" && stack.length > 0) {
    result["errorStackTrace"] = stack.split(/\r?\n/).map(l => l.trim())
      .filter(l => l.length > 0).slice(0, 5).join(" | ");
  }

  return result;
}

/** Normalize the entity key used to group issues by affected entity. */
function entityKey(
  type: string | undefined,
  name: string | undefined
): string {
  return `${type ?? "UNKNOWN"}::${name ?? "UNKNOWN"}`;
}

/**
 * Computes the true time-averaged value from a MetricData[] response using
 * sum/count across all buckets. More accurate than averaging per-bucket value
 * fields (which would give equal weight to sparse periods).
 */
function extractMetricAverage(data: unknown): number | null {
  if (!Array.isArray(data) || data.length === 0) return null;
  const first = data[0] as Record<string, unknown>;
  const metricValues = first?.["metricValues"];
  if (!Array.isArray(metricValues) || metricValues.length === 0) return null;
  let totalSum = 0, bucketCount = 0;
  for (const bucket of metricValues) {
    const b = bucket as Record<string, unknown>;
    const count = typeof b["count"] === "number" ? b["count"] : 0;
    const sum   = typeof b["sum"]   === "number" ? b["sum"]   : 0;
    if (count > 0) { totalSum += sum; bucketCount += count; }
  }
  return bucketCount === 0 ? null : Math.round(totalSum / bucketCount);
}

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

/**
 * Computes percentage change; returns null when comparison is not meaningful.
 */
function computeChangePct(
  current: number | null,
  baseline: number | null,
  minBaseline = 0,
): number | null {
  if (current === null || baseline === null) return null;
  if (baseline < minBaseline) return null;   // baseline too small → skip
  return Math.round(((current - baseline) / baseline) * 100);
}

interface EntityRecord {
  entity: string;
  entityType: string;
  issueCount: number;
  criticalCount: number;
  warningCount: number;
  otherCount: number;
  highestSeverity: string;
  evidence: string[];
}

interface TimelineEntry {
  time: string;
  type: string;
  severity: string;
  description: string;
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

        // Map entityKey → record of aggregated issues
        const entityMap = new Map<string, EntityRecord>();

        function ensureEntity(
          type: string | undefined,
          name: string | undefined
        ): EntityRecord {
          const k = entityKey(type, name);
          if (!entityMap.has(k)) {
            entityMap.set(k, {
              entity: name ?? "Unknown",
              entityType: type ?? "UNKNOWN",
              issueCount: 0,
              criticalCount: 0,
              warningCount: 0,
              otherCount: 0,
              highestSeverity: "INFO",
              evidence: [],
            });
          }
          return entityMap.get(k)!;
        }

        function bumpSeverity(rec: EntityRecord, severity: string): void {
          const order = ["INFO", "WARNING", "WARN", "ERROR", "CRITICAL"];
          const current = order.indexOf(rec.highestSeverity);
          const incoming = order.indexOf(severity.toUpperCase());
          if (incoming > current) {
            rec.highestSeverity = severity.toUpperCase();
          }
        }

        // Process violations
        for (const v of violations) {
          const rec = ensureEntity(v.affectedEntityType, v.affectedEntityName);
          rec.issueCount++;
          const sev = (v.severity ?? "").toUpperCase();
          if (sev === "CRITICAL") rec.criticalCount++;
          else if (sev === "WARNING" || sev === "WARN") rec.warningCount++;
          else rec.otherCount++;
          bumpSeverity(rec, sev);
          rec.evidence.push(`Health rule '${v.name}' ${sev}`);
        }

        // Process error events
        const errorGroupMap = new Map<string, number>(); // error class → count
        for (const ev of errorEvents) {
          const rec = ensureEntity(
            ev.affectedEntityType,
            ev.affectedEntityName
          );
          rec.issueCount++;
          const evSev = (ev.severity ?? "").toUpperCase();
          if (evSev === "ERROR" || evSev === "CRITICAL") rec.criticalCount++;
          else if (evSev === "WARNING" || evSev === "WARN") rec.warningCount++;
          else rec.otherCount++;
          bumpSeverity(rec, evSev || "WARN");
          rec.evidence.push(`${ev.type} event`);

          // Extract error class from summary for error breakdown
          const summary = (ev.summary ?? "").trim();
          if (summary) {
            // Try to pull out a class name: first word before space/colon/semicolon
            const match = summary.match(/^([A-Za-z][\w.$]*(?:Exception|Error|Fault|Problem|Violation|Crash)?)/);
            const key = match ? match[1]! : summary.slice(0, 60);
            errorGroupMap.set(key, (errorGroupMap.get(key) ?? 0) + 1);
          }
        }

        // Process anomaly events
        for (const ev of anomalyEvents) {
          const rec = ensureEntity(
            ev.affectedEntityType,
            ev.affectedEntityName
          );
          rec.issueCount++;
          const sev = ev.type?.includes("CRITICAL") ? "CRITICAL" : "WARNING";
          if (sev === "CRITICAL") rec.criticalCount++;
          else rec.warningCount++;
          bumpSeverity(rec, sev);
          rec.evidence.push(`Anomaly detected (${ev.type})`);
        }

        // Deduplicate evidence per entity (keep first 5 unique)
        for (const rec of entityMap.values()) {
          rec.evidence = [...new Set(rec.evidence)].slice(0, 5);
        }

        // ── Affected entities ──────────────────────────────────────────────
        // (computed before Phase 2 so Phase 2 can prioritize affected tiers)
        const affectedTiers = new Set<string>();
        const affectedBTs = new Set<string>();
        const affectedNodes = new Set<string>();

        for (const rec of entityMap.values()) {
          const t = rec.entityType.toUpperCase();
          if (
            t === "APPLICATION_COMPONENT" ||
            t === "TIER" ||
            t === "APPLICATION_COMPONENT_NODE"
          ) {
            if (t === "APPLICATION_COMPONENT_NODE") {
              affectedNodes.add(rec.entity);
            } else {
              affectedTiers.add(rec.entity);
            }
          } else if (t === "BUSINESS_TRANSACTION" || t === "APPLICATION_COMPONENT_BT") {
            affectedBTs.add(rec.entity);
          }
        }

        // Also pull tier names from BTs affected by snapshots
        for (const bt of bts) {
          if (affectedBTs.has(bt.name)) {
            affectedTiers.add(bt.tierName);
          }
        }

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
        // Weight by severity of degradation: >CRITICAL_PCT = 3 pts, >DEGRADATION_PCT = 1 pt
        for (const t of tierMetrics) {
          for (const [, rec] of entityMap.entries()) {
            if (rec.entity === t.tierName &&
                (rec.entityType.toUpperCase() === "APPLICATION_COMPONENT" || rec.entityType.toUpperCase() === "TIER")) {
              if (t.responseChangePct !== null) {
                if (t.responseChangePct > BASELINE_CRITICAL_PCT) {
                  rec.criticalCount += 3;
                  rec.evidence.push(`Response time +${t.responseChangePct}% vs baseline (${t.avgResponseMs}ms vs ${t.baselineAvgResponseMs}ms)`);
                } else if (t.isSlowResponse) {
                  rec.criticalCount += 1;
                  rec.evidence.push(`Response time +${t.responseChangePct}% vs baseline`);
                }
              }
              if (t.hasNewErrors) {
                rec.warningCount += 1;
                rec.evidence.push(`Errors/min: ${t.errorsPerMin?.toFixed(1)} (was ${t.baselineErrorsPerMin?.toFixed(1) ?? "0"})`);
              }
            }
          }
        }
        for (const n of infraInsights.filter(x => x.isCpuSaturated || x.hasGcPressure)) {
          const rec = ensureEntity("APPLICATION_COMPONENT_NODE", n.nodeName);
          if (n.isCpuSaturated && n.cpuChangePct !== null) {
            const w = n.cpuChangePct > BASELINE_CRITICAL_PCT ? 3 : 1;
            rec.criticalCount += w;
            rec.evidence.push(`CPU +${n.cpuChangePct}% vs baseline (${n.cpuPercent}% vs ${n.baselineCpuPercent}%)`);
          }
          if (n.hasGcPressure && n.gcChangePct !== null) {
            rec.criticalCount += 2;
            rec.evidence.push(`GC time +${n.gcChangePct}% vs baseline (${n.gcTimeMs}ms vs ${n.baselineGcTimeMs}ms)`);
          }
        }
        // Re-deduplicate after boost
        for (const rec of entityMap.values()) rec.evidence = [...new Set(rec.evidence)].slice(0, 7);

        // ── Rank root cause candidates ─────────────────────────────────────
        // Score = critical×3 + warning×2 + other×1
        const ranked = [...entityMap.values()]
          .map((rec) => ({
            ...rec,
            score: rec.criticalCount * 3 + rec.warningCount * 2 + rec.otherCount,
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 5)
          .map(({ score: _score, criticalCount: _c, warningCount: _w, otherCount: _o, ...rest }) => rest);

        // ── Build merged timeline ──────────────────────────────────────────
        const timeline: TimelineEntry[] = [];

        for (const v of violations) {
          const ts = v.startTimeInMillis ?? v.detectedTimeInMillis;
          if (ts) {
            timeline.push({
              time: formatTimestamp(ts),
              type: "HEALTH_RULE_OPEN_" + (v.severity ?? "UNKNOWN").toUpperCase(),
              severity: (v.severity ?? "UNKNOWN").toUpperCase(),
              description: `Health rule '${v.name}' violated on ${v.affectedEntityName ?? "unknown entity"}`,
            });
          }
        }

        for (const ev of errorEvents) {
          if (ev.eventTime) {
            timeline.push({
              time: formatTimestamp(ev.eventTime),
              type: ev.type,
              severity: (ev.severity ?? "WARN").toUpperCase(),
              description: ev.summary ?? ev.type,
            });
          }
        }

        for (const ev of anomalyEvents) {
          if (ev.eventTime) {
            timeline.push({
              time: formatTimestamp(ev.eventTime),
              type: ev.type,
              severity: ev.type?.includes("CRITICAL") ? "CRITICAL" : "WARNING",
              description: ev.summary ?? ev.type,
            });
          }
        }

        // Sort descending (most recent first)
        timeline.sort((a, b) => {
          return b.time > a.time ? 1 : b.time < a.time ? -1 : 0;
        });

        // Limit to 30 timeline entries
        const trimmedTimeline = timeline.slice(0, 30);

        // ── Issue start estimate ───────────────────────────────────────────
        const startTimes: number[] = violations
          .map((v) => v.startTimeInMillis ?? v.detectedTimeInMillis ?? 0)
          .filter((t) => t > 0);

        const issueStartedAround =
          startTimes.length > 0
            ? formatTimestamp(Math.min(...startTimes))
            : null;

        // ── Error breakdown ────────────────────────────────────────────────
        const errorBreakdown: Record<string, number> = {};
        for (const [k, v] of errorGroupMap.entries()) {
          errorBreakdown[k] = v;
        }

        // Sort descending by count
        const sortedErrorBreakdown = Object.fromEntries(
          Object.entries(errorBreakdown).sort(([, a], [, b]) => b - a)
        );

        // ── Summary string ─────────────────────────────────────────────────
        const totalViolations = violations.length;
        const criticalViolations = violations.filter(
          (v) => (v.severity ?? "").toUpperCase() === "CRITICAL"
        ).length;
        const totalAnomalies = anomalyEvents.length;
        const totalErrors = errorEvents.length;

        let summary: string;
        if (
          totalViolations === 0 &&
          totalAnomalies === 0 &&
          totalErrors === 0
        ) {
          summary = `No health violations, anomalies, or error events found in the analysis window (${range.description}). The application appears healthy.`;
        } else {
          const parts: string[] = [];
          if (totalViolations > 0)
            parts.push(
              `${totalViolations} health violation${totalViolations !== 1 ? "s" : ""}` +
                (criticalViolations > 0 ? ` (${criticalViolations} CRITICAL)` : "")
            );
          if (totalAnomalies > 0)
            parts.push(
              `${totalAnomalies} anomal${totalAnomalies !== 1 ? "ies" : "y"}`
            );
          if (totalErrors > 0)
            parts.push(
              `${totalErrors} error/infrastructure event${totalErrors !== 1 ? "s" : ""}`
            );
          summary = `Found ${parts.join(", ")} in the analysis window (${range.description}).`;
        }

        // ── Causality chain ────────────────────────────────────────────────
        // Ordered: infrastructure (root) → backends → application tiers → fallback.
        const causalityChain: string[] = [];

        for (const node of infraInsights) {
          if (node.isCpuSaturated && node.cpuPercent !== null && node.cpuChangePct !== null) {
            const base = node.baselineCpuPercent !== null ? ` vs baseline ${node.baselineCpuPercent}%` : "";
            const tierMs = tierMetrics.find(t => t.tierName === node.tierName)?.avgResponseMs;
            const effect = tierMs != null ? ` → tier '${node.tierName}' avg ${tierMs}ms` : ` in tier '${node.tierName}'`;
            causalityChain.push(`CPU spike on node '${node.nodeName}' (${node.cpuPercent}%${base}, +${node.cpuChangePct}%)${effect}`);
          }
          if (node.hasGcPressure && node.gcTimeMs !== null && node.gcChangePct !== null) {
            const base = node.baselineGcTimeMs !== null ? ` vs baseline ${node.baselineGcTimeMs}ms` : "";
            const heapStr = node.heapUsedMb !== null ? ` with ${node.heapUsedMb}MB heap` : "";
            causalityChain.push(`JVM GC pressure on '${node.nodeName}': ${node.gcTimeMs}ms/min${base} (+${node.gcChangePct}%)${heapStr} — stop-the-world pauses`);
          } else if (node.isHeapPressure && node.heapUsedMb !== null) {
            const base = node.baselineHeapUsedMb !== null ? ` vs baseline ${node.baselineHeapUsedMb}MB` : "";
            causalityChain.push(`Heap growing on '${node.nodeName}': ${node.heapUsedMb}MB${base} — potential memory leak or approaching GC pressure`);
          }
        }

        for (const b of backendAnalysis.filter(x => x.isSlow)) {
          const base = b.baselineAvgResponseMs !== null ? ` vs baseline ${b.baselineAvgResponseMs}ms` : "";
          const pct = b.responseChangePct !== null ? `, +${b.responseChangePct}%` : "";
          const errStr = b.errorsPerMin != null && b.errorsPerMin > 0 ? ` and ${b.errorsPerMin.toFixed(1)} errors/min` : "";
          causalityChain.push(`Slow ${b.type} backend '${b.name}': ${b.avgResponseMs}ms${base}${pct}${errStr} → likely causing upstream BT slowness or failures`);
        }

        for (const t of tierMetrics.filter(x => x.isSlowResponse)) {
          const explainedByInfra = infraInsights.some(n => n.tierName === t.tierName && (n.isCpuSaturated || n.hasGcPressure));
          if (!explainedByInfra) {
            const base = t.baselineAvgResponseMs !== null ? ` vs baseline ${t.baselineAvgResponseMs}ms` : "";
            const pct = t.responseChangePct !== null ? `, +${t.responseChangePct}%` : "";
            causalityChain.push(
              `Tier '${t.tierName}' response degraded: ${t.avgResponseMs}ms${base}${pct}` +
              (t.hasNewErrors ? ` with ${t.errorsPerMin?.toFixed(1)} errors/min` : "") +
              ` — investigate application code or recent deployments`
            );
          }
        }

        if (causalityChain.length === 0 && (violations.length > 0 || anomalyEvents.length > 0)) {
          causalityChain.push("Health rule triggered; no metric degradation detected vs baseline — check application code, recent deployments, or traffic pattern changes");
        }

        // ── Investigation steps ────────────────────────────────────────────
        const steps: string[] = [];
        let stepNum = 1;

        // Infra issues first (root causes)
        for (const n of infraInsights.filter(x => x.isCpuSaturated || x.hasGcPressure).slice(0, 2)) {
          const issues: string[] = [];
          if (n.isCpuSaturated && n.cpuChangePct !== null) issues.push(`CPU +${n.cpuChangePct}% vs baseline`);
          if (n.hasGcPressure  && n.gcChangePct  !== null) issues.push(`GC  +${n.gcChangePct}% vs baseline`);
          steps.push(`${stepNum++}. INFRA: Node '${n.nodeName}' (tier '${n.tierName}') — ${issues.join(", ")}. Investigate host resources, thread pool exhaustion, or memory leak.`);
        }

        // Slow backends
        for (const b of backendAnalysis.filter(x => x.isSlow).slice(0, 2)) {
          const pct = b.responseChangePct !== null ? ` (+${b.responseChangePct}% vs baseline)` : "";
          steps.push(`${stepNum++}. BACKEND: ${b.type} '${b.name}' — ${b.avgResponseMs}ms${pct}. Check query plans, connection pools, or downstream service health.`);
        }

        // Top ranked entity
        if (ranked.length > 0) {
          const top = ranked[0]!;
          steps.push(`${stepNum++}. Focus on '${top.entity}' (${top.entityType}) — highest combined severity/metric score with ${top.issueCount} issue${top.issueCount !== 1 ? "s" : ""}.`);
        }

        // Snapshots
        if (snapshots.length > 0) {
          const btStr = affectedBTs.size > 0 ? ` for ${[...affectedBTs].slice(0, 2).join(", ")}` : "";
          steps.push(`${stepNum++}. Review ${snapshots.length} diagnostic snapshot${snapshots.length !== 1 ? "s" : ""}${btStr} — check sqlQueries, httpCalls, errorStackTrace fields for query-level root causes.`);
        }

        // Top error class
        if (Object.keys(sortedErrorBreakdown).length > 0) {
          const topError = Object.keys(sortedErrorBreakdown)[0]!;
          steps.push(`${stepNum++}. Investigate '${topError}' — most frequent error class (${sortedErrorBreakdown[topError]} occurrences). Check logs for stack traces.`);
        }

        // Deployment check
        if (totalViolations > 0 && issueStartedAround) {
          steps.push(`${stepNum++}. Earliest violation around ${issueStartedAround} — check deployments, config changes, or traffic spikes at that time.`);
        }

        if (steps.length === 0) {
          steps.push("1. No issues detected. Use appd_get_metric_data or appd_browse_metric_tree to explore performance trends.");
        }

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
