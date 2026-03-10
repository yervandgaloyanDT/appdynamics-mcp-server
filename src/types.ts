/**
 * TypeScript interfaces for AppDynamics entities and MCP responses.
 */

// ── MCP Response ────────────────────────────────────────────────────────────

export interface ToolResponse {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// ── Applications ────────────────────────────────────────────────────────────

export interface AppDApplication {
  id: number;
  name: string;
  description?: string;
  accountGuid?: string;
}

// ── Business Transactions ───────────────────────────────────────────────────

export interface BusinessTransaction {
  id: number;
  name: string;
  tierName: string;
  tierId: number;
  entryPointType: string;
  background?: boolean;
  internalName?: string;
}

// ── Metrics ─────────────────────────────────────────────────────────────────

export interface MetricData {
  metricId: number;
  metricName: string;
  metricPath: string;
  frequency: string;
  metricValues: Array<{
    startTimeInMillis: number;
    occurrences: number;
    current: number;
    min: number;
    max: number;
    count: number;
    sum: number;
    value: number;
    standardDeviation: number;
  }>;
}

// ── Health Rules & Violations ───────────────────────────────────────────────

export interface HealthRule {
  id: number;
  name: string;
  type: string;
  enabled: boolean;
  isDefault: boolean;
  affectedEntityType: string;
  [key: string]: unknown;
}

export interface HealthRuleCondition {
  name: string;
  shortcutAlerted: boolean;
  evalDetail: {
    evalDetailType: "SINGLE_METRIC";
    metricAggregateFunction: string;
    metricPath: string;
    metricEvalDetail: {
      metricEvalDetailType: "SPECIFIC_TYPE";
      compareCondition: string;
      compareValue: number;
    };
  };
}

export interface HealthRulePayload {
  name: string;
  enabled: boolean;
  useDataFromLastNMinutes: number;
  waitTimeAfterViolation: number;
  affects: Record<string, unknown>;
  evalCriterias: {
    criticalCriteria: {
      conditionAggregationType: string;
      shortcutAlertEnabled: boolean;
      conditions: HealthRuleCondition[];
    };
    warningCriteria: {
      conditionAggregationType: string;
      shortcutAlertEnabled: boolean;
      conditions: HealthRuleCondition[];
    };
  };
}

export interface HealthRuleViolation {
  id: number;
  name: string;
  severity: string;
  status: string;
  affectedEntityType?: string;
  affectedEntityName?: string;
  affectedEntityId?: number;
  startTimeInMillis?: number;
  endTimeInMillis?: number;
  detectedTimeInMillis?: number;
  incidentStatus?: string;
  description?: string;
  [key: string]: unknown;
}

// ── Events / Anomalies ──────────────────────────────────────────────────────

export interface AppDEvent {
  id: number;
  type: string;
  summary: string;
  severity: string;
  eventTime: number;
  affectedEntityType?: string;
  affectedEntityId?: number;
  affectedEntityName?: string;
  applicationId?: number;
  [key: string]: unknown;
}

// ── Infrastructure ──────────────────────────────────────────────────────────

export interface Tier {
  id: number;
  name: string;
  type?: string;
  agentType?: string;
  numberOfNodes?: number;
  [key: string]: unknown;
}

export interface AppDNode {
  id: number;
  name: string;
  tierId: number;
  tierName: string;
  machineId?: number;
  machineName?: string;
  machineOSType?: string;
  appAgentVersion?: string;
  ipAddresses?: Record<string, string[]>;
  [key: string]: unknown;
}

export interface Backend {
  id: number;
  name: string;
  exitPointType: string;
  properties?: Array<{ name: string; value: string }>;
  [key: string]: unknown;
}

// ── Root Cause Analysis Phase 2 summaries ───────────────────────────────────

export interface TierMetricSummary {
  tierName: string;
  avgResponseMs: number | null;
  baselineAvgResponseMs: number | null;   // prior equivalent window
  responseChangePct: number | null;       // % change vs baseline (positive = worse)
  errorsPerMin: number | null;
  baselineErrorsPerMin: number | null;
  errorsChangePct: number | null;
  isSlowResponse: boolean;                // responseChangePct > BASELINE_DEGRADATION_PCT
  hasNewErrors: boolean;                  // errors increased significantly vs baseline
}

export interface BackendMetricSummary {
  name: string;
  type: string;
  avgResponseMs: number | null;
  baselineAvgResponseMs: number | null;
  responseChangePct: number | null;
  errorsPerMin: number | null;
  baselineErrorsPerMin: number | null;
  isSlow: boolean;                        // responseChangePct > BASELINE_DEGRADATION_PCT
}

export interface InfraNodeSummary {
  tierName: string;
  nodeName: string;
  cpuPercent: number | null;
  baselineCpuPercent: number | null;
  cpuChangePct: number | null;
  heapUsedMb: number | null;
  baselineHeapUsedMb: number | null;
  gcTimeMs: number | null;
  baselineGcTimeMs: number | null;
  gcChangePct: number | null;
  isCpuSaturated: boolean;               // cpuChangePct > BASELINE_DEGRADATION_PCT
  isHeapPressure: boolean;               // heap increased significantly vs baseline
  hasGcPressure: boolean;                // gcChangePct > BASELINE_DEGRADATION_PCT
}

// ── Service Endpoints ───────────────────────────────────────────────────────

export interface ServiceEndpoint {
  id: number;
  name: string;
  tierId?: number;
  tierName?: string;
  sepType?: string;
  [key: string]: unknown;
}

// ── Dashboards ──────────────────────────────────────────────────────────────

export interface DashboardSummary {
  id: number;
  name: string;
  description?: string;
  createdBy?: string;
  modifiedOn?: number;
  [key: string]: unknown;
}

export interface Dashboard {
  id: number;
  name: string;
  description?: string;
  height: number;
  width: number;
  canvasType?: string;
  backgroundColor?: string;
  widgets?: DashboardWidget[];
  [key: string]: unknown;
}

export interface DashboardWidget {
  type: string;
  title: string;
  height: number;
  width: number;
  x: number;
  y: number;
  applicationId?: number;
  metricPath?: string;
  entityType?: string;
  [key: string]: unknown;
}
