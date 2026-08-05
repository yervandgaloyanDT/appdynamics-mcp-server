/**
 * Shared constants for AppDynamics MCP Server
 */

// Maximum characters per tool response to prevent overwhelming the LLM context
export const CHARACTER_LIMIT = 50000;

// Default time ranges in minutes
export const DEFAULT_DURATION_MINS = 60;
export const DEFAULT_VIOLATIONS_DURATION_MINS = 1440; // 24 hours
export const DEFAULT_SNAPSHOT_DURATION_MINS = 30;
export const DEFAULT_ANOMALY_DURATION_MINS = 1440; // 24 hours

// Default result limits
export const DEFAULT_MAX_SNAPSHOTS = 20;
// API request timeout in milliseconds
export const API_TIMEOUT_MS = 30000;

// Maximum simultaneous requests when a tool fans out across applications/tiers.
// Unbounded parallelism trips controller rate limiting (429) on large accounts.
export const MAX_CONCURRENT_REQUESTS = 6;

// Token expiry safety margin in seconds (refresh 5 min before actual expiry)
export const TOKEN_EXPIRY_SAFETY_MARGIN_SECS = 300;

// AppDynamics REST API event types
export const ERROR_EVENT_TYPES = "ERROR,APPLICATION_ERROR,APPLICATION_CRASH";
export const ERROR_SEVERITIES = "ERROR,WARN";

// Diagnostic event types used by appd_diagnose_issue
export const DIAG_ERROR_EVENT_TYPES = [
  "APPLICATION_ERROR",
  "APPLICATION_CRASH",
  "STALL",
  "SLOW_RESPONSE_TIME",
  "DEADLOCK",
  "GC_DURATION_VIOLATION",
  "MEMORY_VIOLATION",
  "CODE_PROBLEM",
].join(",");

export const DIAG_ANOMALY_EVENT_TYPES = "ANOMALY_OPEN_WARNING,ANOMALY_OPEN_CRITICAL";

export const DIAG_EVENT_SEVERITIES = "ERROR,WARN";

export const ANOMALY_EVENT_TYPES = [
  "ANOMALY_OPEN_WARNING",
  "ANOMALY_OPEN_CRITICAL",
  "ANOMALY_CLOSE_WARNING",
  "ANOMALY_CLOSE_CRITICAL",
  "ANOMALY_UPGRADED",
  "ANOMALY_DOWNGRADED",
].join(",");

export const DEFAULT_ANOMALY_SEVERITIES = "INFO,WARN,ERROR";

// Alerting v1 health-rules endpoint. The legacy
// /controller/rest/applications/{id}/health-rules URI returns HTTP 400.
export const healthRulesApiPath = (appId: number): string =>
  `/controller/alerting/rest/v1/applications/${appId}/health-rules`;

// ── Phase 2 baseline comparison ─────────────────────────────────────────────
// Percentage degradation vs prior equivalent window to flag as anomalous.
// "50" means current must be 50% worse than baseline to be flagged.
export const BASELINE_DEGRADATION_PCT = 50;

// Percentage degradation to flag as critical (used in scoring boost weight).
export const BASELINE_CRITICAL_PCT = 100;

// Minimum baseline value for response time (ms) to make a meaningful comparison.
// Prevents false positives when baseline is trivially small (e.g., 2ms → 4ms = 100% but not a real problem).
export const BASELINE_MIN_RESPONSE_MS = 20;

// Minimum baseline errors/min below which any non-zero current value is treated as "new errors".
export const BASELINE_MIN_ERRORS_PER_MIN = 0.5;

// Phase 2 fetch caps (prevent runaway API calls)
export const DIAG_MAX_TIERS_PHASE2 = 3;
export const DIAG_MAX_BACKENDS_PHASE2 = 10;
export const DIAG_MAX_NODES_PER_TIER_PHASE2 = 2;

// Common BT performance metric names
export const BT_METRICS = [
  "Average Response Time (ms)",
  "Calls per Minute",
  "Errors per Minute",
  "Number of Slow Calls",
  "Number of Very Slow Calls",
  "Stall Count",
] as const;
