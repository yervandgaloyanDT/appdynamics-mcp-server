/**
 * Pure analysis logic behind appd_diagnose_issue.
 *
 * Everything here is a total function over already-fetched data: no HTTP, no
 * clock, no environment. The tool in root-cause.ts owns the fetching and calls
 * into this module to correlate, score, rank and narrate — which is what makes
 * the interesting half of the diagnosis unit-testable.
 *
 * Same split as dashboards.ts / dashboard-payloads.ts: keep this file free of I/O.
 */

import { formatTimestamp } from "../utils/formatting.js";
import {
  BASELINE_CRITICAL_PCT,
  BASELINE_DEGRADATION_PCT,
} from "../constants.js";
import type {
  AppDEvent,
  BackendMetricSummary,
  BusinessTransaction,
  HealthRuleViolation,
  InfraNodeSummary,
  TierMetricSummary,
} from "../types.js";

// ── Shared shapes ────────────────────────────────────────────────────────────

export interface EntityRecord {
  entity: string;
  entityType: string;
  issueCount: number;
  criticalCount: number;
  warningCount: number;
  otherCount: number;
  highestSeverity: string;
  evidence: string[];
}

export interface TimelineEntry {
  time: string;
  type: string;
  severity: string;
  description: string;
}

/** Entity records keyed by `${type}::${name}`. */
export type EntityMap = Map<string, EntityRecord>;

export interface AffectedEntities {
  tiers: Set<string>;
  bts: Set<string>;
  nodes: Set<string>;
}

// ── Normalization ────────────────────────────────────────────────────────────

/**
 * The violations endpoint and its /problems fallback return several different
 * envelopes depending on controller version; unwrap them all to a flat array.
 */
export function normalizeViolations(data: unknown): HealthRuleViolation[] {
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
export function extractErrorMessage(reason: unknown): string {
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
export function summarizeSnapshot(snap: unknown): Record<string, unknown> {
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

// ── Metrics ──────────────────────────────────────────────────────────────────

/**
 * Computes the true time-averaged value from a MetricData[] response using
 * sum/count across all buckets. More accurate than averaging per-bucket value
 * fields (which would give equal weight to sparse periods).
 */
export function extractMetricAverage(data: unknown): number | null {
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
 * Computes percentage change; returns null when comparison is not meaningful.
 */
export function computeChangePct(
  current: number | null,
  baseline: number | null,
  minBaseline = 0,
): number | null {
  if (current === null || baseline === null) return null;
  if (baseline < minBaseline) return null;   // baseline too small → skip
  return Math.round(((current - baseline) / baseline) * 100);
}

// ── Correlation ──────────────────────────────────────────────────────────────

/** Normalize the entity key used to group issues by affected entity. */
export function entityKey(
  type: string | undefined,
  name: string | undefined
): string {
  return `${type ?? "UNKNOWN"}::${name ?? "UNKNOWN"}`;
}

/** Fetch-or-create the record for an entity. */
export function ensureEntity(
  entities: EntityMap,
  type: string | undefined,
  name: string | undefined
): EntityRecord {
  const k = entityKey(type, name);
  let rec = entities.get(k);
  if (!rec) {
    rec = {
      entity: name ?? "Unknown",
      entityType: type ?? "UNKNOWN",
      issueCount: 0,
      criticalCount: 0,
      warningCount: 0,
      otherCount: 0,
      highestSeverity: "INFO",
      evidence: [],
    };
    entities.set(k, rec);
  }
  return rec;
}

const SEVERITY_ORDER = ["INFO", "WARNING", "WARN", "ERROR", "CRITICAL"];

/** Raise an entity's recorded severity if the incoming one ranks higher. */
export function bumpSeverity(rec: EntityRecord, severity: string): void {
  const current = SEVERITY_ORDER.indexOf(rec.highestSeverity);
  const incoming = SEVERITY_ORDER.indexOf(severity.toUpperCase());
  if (incoming > current) {
    rec.highestSeverity = severity.toUpperCase();
  }
}

export interface Correlation {
  entities: EntityMap;
  /** Error class name → occurrence count. */
  errorGroups: Map<string, number>;
}

/**
 * Fold violations, error events and anomaly events into per-entity records.
 *
 * Evidence is deduplicated and capped so a hundred repetitions of the same
 * event cannot crowd out a different signal on the same entity.
 */
export function correlate(
  violations: readonly HealthRuleViolation[],
  errorEvents: readonly AppDEvent[],
  anomalyEvents: readonly AppDEvent[]
): Correlation {
  const entities: EntityMap = new Map();
  const errorGroups = new Map<string, number>();

  for (const v of violations) {
    const rec = ensureEntity(entities, v.affectedEntityType, v.affectedEntityName);
    rec.issueCount++;
    const sev = (v.severity ?? "").toUpperCase();
    if (sev === "CRITICAL") rec.criticalCount++;
    else if (sev === "WARNING" || sev === "WARN") rec.warningCount++;
    else rec.otherCount++;
    bumpSeverity(rec, sev);
    rec.evidence.push(`Health rule '${v.name}' ${sev}`);
  }

  for (const ev of errorEvents) {
    const rec = ensureEntity(entities, ev.affectedEntityType, ev.affectedEntityName);
    rec.issueCount++;
    const evSev = (ev.severity ?? "").toUpperCase();
    if (evSev === "ERROR" || evSev === "CRITICAL") rec.criticalCount++;
    else if (evSev === "WARNING" || evSev === "WARN") rec.warningCount++;
    else rec.otherCount++;
    bumpSeverity(rec, evSev || "WARN");
    rec.evidence.push(`${ev.type} event`);

    // Group by exception/error class so the breakdown names real failures
    // rather than one bucket per unique message.
    const summary = (ev.summary ?? "").trim();
    if (summary) {
      const match = summary.match(
        /^([A-Za-z][\w.$]*(?:Exception|Error|Fault|Problem|Violation|Crash)?)/
      );
      const key = match ? match[1]! : summary.slice(0, 60);
      errorGroups.set(key, (errorGroups.get(key) ?? 0) + 1);
    }
  }

  for (const ev of anomalyEvents) {
    const rec = ensureEntity(entities, ev.affectedEntityType, ev.affectedEntityName);
    rec.issueCount++;
    const sev = ev.type?.includes("CRITICAL") ? "CRITICAL" : "WARNING";
    if (sev === "CRITICAL") rec.criticalCount++;
    else rec.warningCount++;
    bumpSeverity(rec, sev);
    rec.evidence.push(`Anomaly detected (${ev.type})`);
  }

  dedupeEvidence(entities, 5);
  return { entities, errorGroups };
}

/** Keep the first `limit` unique evidence strings per entity. */
export function dedupeEvidence(entities: EntityMap, limit: number): void {
  for (const rec of entities.values()) {
    rec.evidence = [...new Set(rec.evidence)].slice(0, limit);
  }
}

/**
 * Split correlated entities into the tier / BT / node buckets that Phase 2
 * uses to decide which metrics are worth fetching.
 */
export function collectAffectedEntities(
  entities: EntityMap,
  bts: readonly BusinessTransaction[]
): AffectedEntities {
  const tiers = new Set<string>();
  const btNames = new Set<string>();
  const nodes = new Set<string>();

  for (const rec of entities.values()) {
    const t = rec.entityType.toUpperCase();
    if (
      t === "APPLICATION_COMPONENT" ||
      t === "TIER" ||
      t === "APPLICATION_COMPONENT_NODE"
    ) {
      if (t === "APPLICATION_COMPONENT_NODE") nodes.add(rec.entity);
      else tiers.add(rec.entity);
    } else if (t === "BUSINESS_TRANSACTION" || t === "APPLICATION_COMPONENT_BT") {
      btNames.add(rec.entity);
    }
  }

  // A struggling BT implicates the tier hosting it.
  for (const bt of bts) {
    if (btNames.has(bt.name)) tiers.add(bt.tierName);
  }

  return { tiers, bts: btNames, nodes };
}

// ── Scoring ──────────────────────────────────────────────────────────────────

/**
 * Fold Phase 2 metric degradation into the entity scores.
 *
 * Weighting is proportional to how far past baseline a measurement is, so a
 * doubling outranks a marginal regression instead of both counting as one hit.
 */
export function applyMetricBoosts(
  entities: EntityMap,
  tierMetrics: readonly TierMetricSummary[],
  infraInsights: readonly InfraNodeSummary[]
): void {
  for (const t of tierMetrics) {
    for (const rec of entities.values()) {
      const type = rec.entityType.toUpperCase();
      const isTier = type === "APPLICATION_COMPONENT" || type === "TIER";
      if (rec.entity !== t.tierName || !isTier) continue;

      if (t.responseChangePct !== null) {
        if (t.responseChangePct > BASELINE_CRITICAL_PCT) {
          rec.criticalCount += 3;
          rec.evidence.push(
            `Response time +${t.responseChangePct}% vs baseline (${t.avgResponseMs}ms vs ${t.baselineAvgResponseMs}ms)`
          );
        } else if (t.isSlowResponse) {
          rec.criticalCount += 1;
          rec.evidence.push(`Response time +${t.responseChangePct}% vs baseline`);
        }
      }
      if (t.hasNewErrors) {
        rec.warningCount += 1;
        rec.evidence.push(
          `Errors/min: ${t.errorsPerMin?.toFixed(1)} (was ${t.baselineErrorsPerMin?.toFixed(1) ?? "0"})`
        );
      }
    }
  }

  for (const n of infraInsights) {
    if (!n.isCpuSaturated && !n.hasGcPressure) continue;
    const rec = ensureEntity(entities, "APPLICATION_COMPONENT_NODE", n.nodeName);
    if (n.isCpuSaturated && n.cpuChangePct !== null) {
      rec.criticalCount += n.cpuChangePct > BASELINE_CRITICAL_PCT ? 3 : 1;
      rec.evidence.push(
        `CPU +${n.cpuChangePct}% vs baseline (${n.cpuPercent}% vs ${n.baselineCpuPercent}%)`
      );
    }
    if (n.hasGcPressure && n.gcChangePct !== null) {
      rec.criticalCount += 2;
      rec.evidence.push(
        `GC time +${n.gcChangePct}% vs baseline (${n.gcTimeMs}ms vs ${n.baselineGcTimeMs}ms)`
      );
    }
  }

  dedupeEvidence(entities, 7);
}

/** Score = critical×3 + warning×2 + other×1. */
export function scoreEntity(rec: EntityRecord): number {
  return rec.criticalCount * 3 + rec.warningCount * 2 + rec.otherCount;
}

/**
 * Top candidates, highest score first. The count fields are internal scoring
 * detail and are dropped from the response.
 */
export function rankCandidates(
  entities: EntityMap,
  limit = 5
): Array<Omit<EntityRecord, "criticalCount" | "warningCount" | "otherCount">> {
  return [...entities.values()]
    .map((rec) => ({ rec, score: scoreEntity(rec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ rec }) => ({
      entity: rec.entity,
      entityType: rec.entityType,
      issueCount: rec.issueCount,
      highestSeverity: rec.highestSeverity,
      evidence: rec.evidence,
    }));
}

// ── Narrative ────────────────────────────────────────────────────────────────

/** Merge every event source into one time-ordered list, most recent first. */
export function buildTimeline(
  violations: readonly HealthRuleViolation[],
  errorEvents: readonly AppDEvent[],
  anomalyEvents: readonly AppDEvent[],
  limit = 30
): TimelineEntry[] {
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

  // Timestamps are fixed-width ISO-like strings, so lexical order is chronological.
  timeline.sort((a, b) => (b.time > a.time ? 1 : b.time < a.time ? -1 : 0));
  return timeline.slice(0, limit);
}

/** Earliest violation start, or null when nothing carries a timestamp. */
export function estimateIssueStart(
  violations: readonly HealthRuleViolation[]
): string | null {
  const startTimes = violations
    .map((v) => v.startTimeInMillis ?? v.detectedTimeInMillis ?? 0)
    .filter((t) => t > 0);

  return startTimes.length > 0 ? formatTimestamp(Math.min(...startTimes)) : null;
}

/** Error class counts, most frequent first. */
export function sortErrorBreakdown(
  errorGroups: ReadonlyMap<string, number>
): Record<string, number> {
  return Object.fromEntries([...errorGroups.entries()].sort(([, a], [, b]) => b - a));
}

/** One-line headline for the report. */
export function buildSummary(
  violations: readonly HealthRuleViolation[],
  anomalyEvents: readonly AppDEvent[],
  errorEvents: readonly AppDEvent[],
  rangeDescription: string
): string {
  const totalViolations = violations.length;
  const totalAnomalies = anomalyEvents.length;
  const totalErrors = errorEvents.length;

  if (totalViolations === 0 && totalAnomalies === 0 && totalErrors === 0) {
    return `No health violations, anomalies, or error events found in the analysis window (${rangeDescription}). The application appears healthy.`;
  }

  const criticalViolations = violations.filter(
    (v) => (v.severity ?? "").toUpperCase() === "CRITICAL"
  ).length;

  const parts: string[] = [];
  if (totalViolations > 0) {
    parts.push(
      `${totalViolations} health violation${totalViolations !== 1 ? "s" : ""}` +
        (criticalViolations > 0 ? ` (${criticalViolations} CRITICAL)` : "")
    );
  }
  if (totalAnomalies > 0) {
    parts.push(`${totalAnomalies} anomal${totalAnomalies !== 1 ? "ies" : "y"}`);
  }
  if (totalErrors > 0) {
    parts.push(
      `${totalErrors} error/infrastructure event${totalErrors !== 1 ? "s" : ""}`
    );
  }

  return `Found ${parts.join(", ")} in the analysis window (${rangeDescription}).`;
}

/**
 * Narrate cause → effect, ordered infrastructure first so the chain reads from
 * the deepest plausible root outward rather than from the loudest symptom.
 */
export function buildCausalityChain(
  infraInsights: readonly InfraNodeSummary[],
  backendAnalysis: readonly BackendMetricSummary[],
  tierMetrics: readonly TierMetricSummary[],
  hasAlerts: boolean
): string[] {
  const chain: string[] = [];

  for (const node of infraInsights) {
    if (node.isCpuSaturated && node.cpuPercent !== null && node.cpuChangePct !== null) {
      const base = node.baselineCpuPercent !== null ? ` vs baseline ${node.baselineCpuPercent}%` : "";
      const tierMs = tierMetrics.find((t) => t.tierName === node.tierName)?.avgResponseMs;
      const effect = tierMs != null
        ? ` → tier '${node.tierName}' avg ${tierMs}ms`
        : ` in tier '${node.tierName}'`;
      chain.push(
        `CPU spike on node '${node.nodeName}' (${node.cpuPercent}%${base}, +${node.cpuChangePct}%)${effect}`
      );
    }
    if (node.hasGcPressure && node.gcTimeMs !== null && node.gcChangePct !== null) {
      const base = node.baselineGcTimeMs !== null ? ` vs baseline ${node.baselineGcTimeMs}ms` : "";
      const heapStr = node.heapUsedMb !== null ? ` with ${node.heapUsedMb}MB heap` : "";
      chain.push(
        `JVM GC pressure on '${node.nodeName}': ${node.gcTimeMs}ms/min${base} (+${node.gcChangePct}%)${heapStr} — stop-the-world pauses`
      );
    } else if (node.isHeapPressure && node.heapUsedMb !== null) {
      const base = node.baselineHeapUsedMb !== null ? ` vs baseline ${node.baselineHeapUsedMb}MB` : "";
      chain.push(
        `Heap growing on '${node.nodeName}': ${node.heapUsedMb}MB${base} — potential memory leak or approaching GC pressure`
      );
    }
  }

  for (const b of backendAnalysis) {
    if (!b.isSlow) continue;
    const base = b.baselineAvgResponseMs !== null ? ` vs baseline ${b.baselineAvgResponseMs}ms` : "";
    const pct = b.responseChangePct !== null ? `, +${b.responseChangePct}%` : "";
    const errStr =
      b.errorsPerMin != null && b.errorsPerMin > 0
        ? ` and ${b.errorsPerMin.toFixed(1)} errors/min`
        : "";
    chain.push(
      `Slow ${b.type} backend '${b.name}': ${b.avgResponseMs}ms${base}${pct}${errStr} → likely causing upstream BT slowness or failures`
    );
  }

  for (const t of tierMetrics) {
    if (!t.isSlowResponse) continue;
    // A tier already explained by its own node's CPU/GC is not a separate cause.
    const explainedByInfra = infraInsights.some(
      (n) => n.tierName === t.tierName && (n.isCpuSaturated || n.hasGcPressure)
    );
    if (explainedByInfra) continue;

    const base = t.baselineAvgResponseMs !== null ? ` vs baseline ${t.baselineAvgResponseMs}ms` : "";
    const pct = t.responseChangePct !== null ? `, +${t.responseChangePct}%` : "";
    chain.push(
      `Tier '${t.tierName}' response degraded: ${t.avgResponseMs}ms${base}${pct}` +
        (t.hasNewErrors ? ` with ${t.errorsPerMin?.toFixed(1)} errors/min` : "") +
        ` — investigate application code or recent deployments`
    );
  }

  if (chain.length === 0 && hasAlerts) {
    chain.push(
      "Health rule triggered; no metric degradation detected vs baseline — check application code, recent deployments, or traffic pattern changes"
    );
  }

  return chain;
}

/** Inputs for the ordered "what to look at next" list. */
export interface InvestigationInputs {
  infraInsights: readonly InfraNodeSummary[];
  backendAnalysis: readonly BackendMetricSummary[];
  ranked: ReadonlyArray<{ entity: string; entityType: string; issueCount: number }>;
  snapshotCount: number;
  affectedBTs: ReadonlySet<string>;
  errorBreakdown: Readonly<Record<string, number>>;
  violationCount: number;
  issueStartedAround: string | null;
}

/**
 * Ordered investigation steps, deepest-cause first: infrastructure, then
 * backends, then the highest-scoring entity, then supporting evidence.
 */
export function buildInvestigationSteps(input: InvestigationInputs): string[] {
  const steps: string[] = [];
  let stepNum = 1;

  for (const n of input.infraInsights
    .filter((x) => x.isCpuSaturated || x.hasGcPressure)
    .slice(0, 2)) {
    const issues: string[] = [];
    if (n.isCpuSaturated && n.cpuChangePct !== null) issues.push(`CPU +${n.cpuChangePct}% vs baseline`);
    if (n.hasGcPressure && n.gcChangePct !== null) issues.push(`GC  +${n.gcChangePct}% vs baseline`);
    steps.push(
      `${stepNum++}. INFRA: Node '${n.nodeName}' (tier '${n.tierName}') — ${issues.join(", ")}. Investigate host resources, thread pool exhaustion, or memory leak.`
    );
  }

  for (const b of input.backendAnalysis.filter((x) => x.isSlow).slice(0, 2)) {
    const pct = b.responseChangePct !== null ? ` (+${b.responseChangePct}% vs baseline)` : "";
    steps.push(
      `${stepNum++}. BACKEND: ${b.type} '${b.name}' — ${b.avgResponseMs}ms${pct}. Check query plans, connection pools, or downstream service health.`
    );
  }

  const top = input.ranked[0];
  if (top) {
    steps.push(
      `${stepNum++}. Focus on '${top.entity}' (${top.entityType}) — highest combined severity/metric score with ${top.issueCount} issue${top.issueCount !== 1 ? "s" : ""}.`
    );
  }

  if (input.snapshotCount > 0) {
    const btStr =
      input.affectedBTs.size > 0
        ? ` for ${[...input.affectedBTs].slice(0, 2).join(", ")}`
        : "";
    steps.push(
      `${stepNum++}. Review ${input.snapshotCount} diagnostic snapshot${input.snapshotCount !== 1 ? "s" : ""}${btStr} — check sqlQueries, httpCalls, errorStackTrace fields for query-level root causes.`
    );
  }

  const errorClasses = Object.keys(input.errorBreakdown);
  const topError = errorClasses[0];
  if (topError !== undefined) {
    steps.push(
      `${stepNum++}. Investigate '${topError}' — most frequent error class (${input.errorBreakdown[topError]} occurrences). Check logs for stack traces.`
    );
  }

  if (input.violationCount > 0 && input.issueStartedAround) {
    steps.push(
      `${stepNum++}. Earliest violation around ${input.issueStartedAround} — check deployments, config changes, or traffic spikes at that time.`
    );
  }

  if (steps.length === 0) {
    steps.push(
      "1. No issues detected. Use appd_get_metric_data or appd_browse_metric_tree to explore performance trends."
    );
  }

  return steps;
}

/** True when a regression is large enough to report as degradation. */
export function isDegraded(changePct: number | null): boolean {
  return changePct !== null && changePct > BASELINE_DEGRADATION_PCT;
}
