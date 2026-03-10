/**
 * Build and verify a 47-widget AppDynamics operations dashboard for Java-App1.
 *
 * Layout (47 widgets across 7 sections + 1 title banner):
 *   [0]  Dashboard title banner                           (1 widget)
 *   [1]  Application Overview: header + 3 TS + 6 tiles  (10 widgets)
 *   [2]  Health Status: HEALTH_LIST                       (1 widget)
 *   [3]  BT Response Times: header + 8 timeseries        (9 widgets)
 *   [4]  BT Throughput & Errors: 2 BTs × 4 metrics       (8 widgets)
 *   [5]  JVM Health (FrontEnd): header + 7 tiles         (8 widgets)
 *   [6]  Hardware Infrastructure: 4 tiles                (4 widgets)
 *   [7]  Backend Dependencies: 6 tiles                   (6 widgets)
 *
 * Run: npx tsx scripts/build-check-dash.ts
 */

import { appdGet, appdGetRaw, appdPost, appdPostFormData } from "../src/services/api-client.js";
import { randomUUID } from "crypto";

// ── Constants ─────────────────────────────────────────────────────────────────
const APP_ID   = 50606;
const APP_NAME = "Java-App1";
const DASH_NAME = "Java-App1 — Operations Dashboard";

const COLOR_WHITE      = 16777215;
const COLOR_LIGHT_GRAY = 15856629;
const COLOR_DARK       = 1646891;
const COLOR_BORDER     = 14408667;

// Discovered structure
const TIER_FRONTEND = "FrontEnd";

// Top 8 BTs with confirmed live traffic (verified against 60-min window)
const TOP_BTS = [
  { id: 10442386, name: "/quoterequest",                        tierName: "FrontEnd" },
  { id: 10442387, name: "/processorder/electronics",            tierName: "FrontEnd" },
  { id: 10442395, name: "/product/furniture/Dining Table",      tierName: "FrontEnd" },
  { id: 10442396, name: "/product/outdoor/MultifunctionKnife",  tierName: "FrontEnd" },
  { id: 10442398, name: "/product/outdoor/BackPack",            tierName: "FrontEnd" },
  { id: 10442403, name: "/product/furniture/SwivelChair",       tierName: "FrontEnd" },
  { id: 10442383, name: "/http/to3d",                           tierName: "OrderProcessing" },
  { id: 10442384, name: "/http/to2nd",                          tierName: "Inventory" },
];

// Backends (AppDynamics prefixes discovered backends with "Discovered backend call - ")
const BACKEND_MYSQL1  = "Discovered backend call - MYSQL-AppDynamics-LOCALHOST-1.0";
const BACKEND_MYSQL2  = "Discovered backend call - NEWSCHEMA-MYSQL-LOCALHOST-5.6";
const BACKEND_HTTP1   = "Discovered backend call - Kivity-Ultra-7:10010";
const BACKEND_HTTP2   = "Discovered backend call - Kivity-Ultra-7:10011";

// ── Widget types ──────────────────────────────────────────────────────────────
interface WidgetDef {
  type: string;
  title: string;
  width: number;
  height: number;
  x: number;
  y: number;
  metricPath?: string;
  text?: string;
  entityType?: string;
  btIds?: number[];
}

// ── Build widgets list ────────────────────────────────────────────────────────
const widgets: WidgetDef[] = [];
let y = 0;

function push(w: WidgetDef): void { widgets.push(w); }

// ════════════════════════════════════════════════════════
// [0] Dashboard title banner (1 widget)
// ════════════════════════════════════════════════════════
push({ type: "TEXT", title: "DashTitle", width: 12, height: 1, x: 0, y,
  text: "Java-App1 — Operations Dashboard" });
y += 1;

// ════════════════════════════════════════════════════════
// [1] Application Overview (10 widgets)
// ════════════════════════════════════════════════════════
push({ type: "TEXT", title: "Section: Application Overview", width: 12, height: 1, x: 0, y,
  text: "── Application Overview ──" });
y += 1;

// 3 time-series graphs (row, 4-wide each)
const overviewTS = [
  { title: "Avg Response Time (ms)",  metric: "Overall Application Performance|Average Response Time (ms)" },
  { title: "Calls per Minute",        metric: "Overall Application Performance|Calls per Minute" },
  { title: "Errors per Minute",       metric: "Overall Application Performance|Errors per Minute" },
];
overviewTS.forEach((g, i) => {
  push({ type: "TIMESERIES_GRAPH", title: g.title, metricPath: g.metric,
    width: 4, height: 3, x: i * 4, y });
});
y += 3;

// 6 metric value tiles (row, 2-wide each)
const overviewTiles = [
  { title: "Avg Response",    metric: "Overall Application Performance|Average Response Time (ms)" },
  { title: "Calls/Min",       metric: "Overall Application Performance|Calls per Minute" },
  { title: "Errors/Min",      metric: "Overall Application Performance|Errors per Minute" },
  { title: "Stall Count",     metric: "Overall Application Performance|Stall Count" },
  { title: "Slow Calls",      metric: "Overall Application Performance|Number of Slow Calls" },
  { title: "Very Slow Calls", metric: "Overall Application Performance|Number of Very Slow Calls" },
];
overviewTiles.forEach((t, i) => {
  push({ type: "METRIC_VALUE", title: t.title, metricPath: t.metric,
    width: 2, height: 2, x: i * 2, y });
});
y += 2;

// ════════════════════════════════════════════════════════
// [2] Health Status (1 widget)
// ════════════════════════════════════════════════════════
push({ type: "HEALTH_LIST", title: "Health Rule Violations", entityType: "APPLICATION",
  width: 12, height: 4, x: 0, y });
y += 4;

// ════════════════════════════════════════════════════════
// [3] BT Response Times (9 widgets = 1 header + 8 BT TS)
// ════════════════════════════════════════════════════════
push({ type: "TEXT", title: "Section: BT Response Times", width: 12, height: 1, x: 0, y,
  text: "── BT Response Times ──" });
y += 1;

// Row 1: BT 0-3
TOP_BTS.slice(0, 4).forEach((bt, i) => {
  push({ type: "TIMESERIES_GRAPH",
    title: `${bt.name} Resp Time`,
    metricPath: `Business Transaction Performance|Business Transactions|${bt.tierName}|${bt.name}|Average Response Time (ms)`,
    btIds: [bt.id],
    width: 3, height: 3, x: i * 3, y });
});
y += 3;

// Row 2: BT 4-7
TOP_BTS.slice(4, 8).forEach((bt, i) => {
  push({ type: "TIMESERIES_GRAPH",
    title: `${bt.name} Resp Time`,
    metricPath: `Business Transaction Performance|Business Transactions|${bt.tierName}|${bt.name}|Average Response Time (ms)`,
    btIds: [bt.id],
    width: 3, height: 3, x: i * 3, y });
});
y += 3;

// ════════════════════════════════════════════════════════
// [4] BT Throughput & Errors (8 widgets = 2 BTs × 4 metrics)
// ════════════════════════════════════════════════════════
const btTput = [TOP_BTS[0]!, TOP_BTS[1]!]; // /quoterequest + /processorder/electronics
const btMetrics = [
  { suffix: "Calls per Minute",                  label: "Calls/Min" },
  { suffix: "Errors per Minute",                 label: "Errors/Min" },
  { suffix: "95th Percentile Response Time (ms)", label: "95th Pct" },
  { suffix: "Stall Count",                       label: "Stall Count" },
];

btTput.forEach((bt, row) => {
  btMetrics.forEach((m, col) => {
    push({ type: "METRIC_VALUE",
      title: `${bt.name} ${m.label}`,
      metricPath: `Business Transaction Performance|Business Transactions|${bt.tierName}|${bt.name}|${m.suffix}`,
      btIds: [bt.id],
      width: 3, height: 2, x: col * 3, y });
  });
  y += 2;
});

// ════════════════════════════════════════════════════════
// [5] JVM Health — FrontEnd tier (8 widgets = 1 header + 7 tiles)
// ════════════════════════════════════════════════════════
push({ type: "TEXT", title: "Section: JVM Health (FrontEnd)", width: 12, height: 1, x: 0, y,
  text: "── JVM Health (FrontEnd) ──" });
y += 1;

const jvmMetrics = [
  { title: "Heap Used %",      metric: `Application Infrastructure Performance|${TIER_FRONTEND}|JVM|Memory|Heap|Used %` },
  { title: "Heap Used (MB)",   metric: `Application Infrastructure Performance|${TIER_FRONTEND}|JVM|Memory|Heap|Current Usage (MB)` },
  { title: "GC Time (ms/min)", metric: `Application Infrastructure Performance|${TIER_FRONTEND}|JVM|Garbage Collection|GC Time Spent Per Min (ms)` },
  { title: "Thread Count",     metric: `Application Infrastructure Performance|${TIER_FRONTEND}|JVM|Threads|Current No. of Threads` },
];
jvmMetrics.forEach((m, i) => {
  push({ type: "METRIC_VALUE", title: m.title, metricPath: m.metric,
    width: 3, height: 2, x: i * 3, y });
});
y += 2;

const jvmMetrics2 = [
  { title: "CPU %",         metric: `Application Infrastructure Performance|${TIER_FRONTEND}|JVM|Process CPU Usage %` },
  { title: "Major GC/min",  metric: `Application Infrastructure Performance|${TIER_FRONTEND}|JVM|Garbage Collection|Number of Major Collections Per Min` },
  { title: "Minor GC/min",  metric: `Application Infrastructure Performance|${TIER_FRONTEND}|JVM|Garbage Collection|Number of Minor Collections Per Min` },
];
jvmMetrics2.forEach((m, i) => {
  push({ type: "METRIC_VALUE", title: m.title, metricPath: m.metric,
    width: 4, height: 2, x: i * 4, y });
});
y += 2;

// ════════════════════════════════════════════════════════
// [6] Hardware Infrastructure (4 widgets)
// ════════════════════════════════════════════════════════
const hwMetrics = [
  { title: "CPU Busy %",     metric: `Application Infrastructure Performance|${TIER_FRONTEND}|Hardware Resources|CPU|%Busy` },
  { title: "CPU Idle %",     metric: `Application Infrastructure Performance|${TIER_FRONTEND}|Hardware Resources|CPU|%Idle` },
  { title: "Memory Used %",  metric: `Application Infrastructure Performance|${TIER_FRONTEND}|Hardware Resources|Memory|Used %` },
  { title: "Memory Used MB", metric: `Application Infrastructure Performance|${TIER_FRONTEND}|Hardware Resources|Memory|Used (MB)` },
];
hwMetrics.forEach((m, i) => {
  push({ type: "METRIC_VALUE", title: m.title, metricPath: m.metric,
    width: 3, height: 2, x: i * 3, y });
});
y += 2;

// ════════════════════════════════════════════════════════
// [7] Backend Dependencies (6 widgets)
// ════════════════════════════════════════════════════════
const backendWidgets = [
  { title: "MySQL1 Resp Time (ms)",  metric: `Backends|${BACKEND_MYSQL1}|Average Response Time (ms)` },
  { title: "MySQL1 Calls/Min",       metric: `Backends|${BACKEND_MYSQL1}|Calls per Minute` },
  { title: "MySQL1 Errors/Min",      metric: `Backends|${BACKEND_MYSQL1}|Errors per Minute` },
  { title: "MySQL2 Resp Time (ms)",  metric: `Backends|${BACKEND_MYSQL2}|Average Response Time (ms)` },
  { title: "HTTP:10010 Resp Time",   metric: `Backends|${BACKEND_HTTP1}|Average Response Time (ms)` },
  { title: "HTTP:10011 Resp Time",   metric: `Backends|${BACKEND_HTTP2}|Average Response Time (ms)` },
];
backendWidgets.forEach((w, i) => {
  push({ type: "METRIC_VALUE", title: w.title, metricPath: w.metric,
    width: 4, height: 2, x: (i % 3) * 4, y: y + Math.floor(i / 3) * 2 });
});
y += 4;

// ── Sanity check ──────────────────────────────────────────────────────────────
console.log(`\nTotal widgets: ${widgets.length} (expected 47)`);
if (widgets.length !== 47) {
  console.error(`ERROR: Widget count mismatch! Got ${widgets.length}`);
  process.exit(1);
}

// ── Export format helpers ─────────────────────────────────────────────────────

const EXPORT_TYPE_MAP: Record<string, string> = {
  TIMESERIES_GRAPH: "GraphWidget",
  METRIC_VALUE: "MetricLabelWidget",
  HEALTH_LIST: "HealthListWidget",
  TEXT: "TextWidget",
  PIE: "PieWidget",
  GAUGE: "GaugeWidget",
};

function buildExportWidget(w: WidgetDef, index: number): Record<string, unknown> {
  const widgetType = EXPORT_TYPE_MAP[w.type] ?? w.type;

  const base: Record<string, unknown> = {
    widgetType,
    title: w.title,
    height: w.height,
    width: w.width,
    minHeight: 0,
    minWidth: 0,
    x: w.x,
    y: w.y,
    label: null,
    description: null,
    drillDownUrl: null,
    openUrlInCurrentTab: false,
    useMetricBrowserAsDrillDown: widgetType !== "TextWidget" && widgetType !== "HealthListWidget",
    drillDownActionType: null,
    backgroundColor: COLOR_WHITE,
    backgroundColors: null,
    backgroundColorsStr: `${COLOR_WHITE},${COLOR_WHITE}`,
    color: COLOR_DARK,
    fontSize: 12,
    useAutomaticFontSize: false,
    borderEnabled: false,
    borderThickness: 0,
    borderColor: COLOR_BORDER,
    backgroundAlpha: 1,
    showValues: false,
    formatNumber: true,
    numDecimals: 0,
    removeZeros: true,
    compactMode: false,
    showTimeRange: false,
    renderIn3D: false,
    showLegend: null,
    legendPosition: null,
    legendColumnCount: null,
    timeRangeSpecifierType: "UNKNOWN",
    startTime: null,
    endTime: null,
    minutesBeforeAnchorTime: 15,
    isGlobal: true,
    propertiesMap: null,
    dataSeriesTemplates: null,
  };

  if (widgetType === "TextWidget") {
    base.useMetricBrowserAsDrillDown = false;
    base.text = w.text ?? "";
    return base;
  }

  if (widgetType === "HealthListWidget") {
    base.applicationReference = null;
    base.entityReferences = [{
      applicationName: APP_NAME,
      entityType: "APPLICATION",
      entityName: APP_NAME,
      scopingEntityType: null,
      scopingEntityName: null,
      subtype: null,
      uniqueKey: null,
    }];
    base.entityType = w.entityType ?? "POLICY";
    base.entitySelectionType = "ALL";
    base.iconSize = 18;
    base.iconPosition = "LEFT";
    base.showSearchBox = false;
    base.showList = true;
    base.showListHeader = false;
    base.showBarPie = true;
    base.showPie = false;
    base.showCurrentHealthStatus = false;
    base.innerRadius = 0;
    base.aggregationType = "RATIO";
    return base;
  }

  if (w.metricPath) {
    const inputMetricPath = `Root||Applications||${APP_NAME}||` + w.metricPath.replace(/\|/g, "||");
    const isBT = w.metricPath.startsWith("Business Transaction Performance");
    const metricType = isBT ? "BUSINESS_TRANSACTION" : "OVERALL_APPLICATION";
    const entityType = isBT ? "BUSINESS_TRANSACTION" : "APPLICATION";
    const evaluationScopeType = isBT ? "TIER_AVERAGE" : null;

    base.dataSeriesTemplates = [{
      seriesType: "LINE",
      metricType,
      showRawMetricName: false,
      colorPalette: null,
      name: `Series ${index}`,
      metricMatchCriteriaTemplate: {
        entityMatchCriteria: {
          matchCriteriaType: "SpecificEntities",
          entityType,
          agentTypes: null,
          entityNames: [],
          summary: false,
        },
        metricExpressionTemplate: {
          metricExpressionType: "Logical",
          functionType: "VALUE",
          displayName: null,
          inputMetricText: false,
          inputMetricPath,
          relativeMetricPath: w.metricPath,
        },
        rollupMetricData: false,
        expressionString: "",
        useActiveBaseline: false,
        sortResultsAscending: false,
        maxResults: 20,
        evaluationScopeType,
        baselineName: null,
        applicationName: APP_NAME,
        metricDisplayNameStyle: "DISPLAY_STYLE_AUTO",
        metricDisplayNameCustomFormat: null,
        includeHistoricalNodes: null,
        includeAbove: null,
        includeBelow: null,
        includeBoth: null,
        includeBand12: null,
        includeBand23: null,
        includeBand34: null,
        includeBand45: null,
        includeShade: null,
      },
      axisPosition: null,
    }];
  }

  if (widgetType === "MetricLabelWidget") {
    base.label = "${v}";
    base.text = null;
    base.textAlign = "RIGHT";
    base.margin = 15;
    base.showLabel = false;
    base.showBaseline = false;
    base.useBaselineColor = false;
    base.reverseBaselineColorOrder = false;
  }

  if (widgetType === "GraphWidget") {
    base.showValues = false;
    base.showLegend = true;
    base.legendPosition = "POSITION_BOTTOM";
    base.legendColumnCount = 1;
    base.verticalAxisLabel = null;
    base.hideHorizontalAxis = null;
    base.horizontalAxisLabel = null;
    base.axisType = "LINEAR";
    base.stackMode = null;
    base.multipleYAxis = null;
    base.customVerticalAxisMin = null;
    base.customVerticalAxisMax = null;
    base.showEvents = null;
    base.interpolateDataGaps = false;
    base.showAllTooltips = null;
    base.staticThresholdList = [];
    base.eventFilterTemplate = null;
  }

  return base;
}

function buildExportEnvelope(widgetTemplates: Record<string, unknown>[]): Record<string, unknown> {
  return {
    schemaVersion: null,
    dashboardFormatVersion: "4.0",
    name: DASH_NAME,
    description: "Auto-generated 47-widget operations dashboard for Java-App1",
    properties: null,
    templateEntityType: "APPLICATION_COMPONENT_NODE",
    associatedEntityTemplates: null,
    timeRangeSpecifierType: "UNKNOWN",
    minutesBeforeAnchorTime: -1,
    startDate: null,
    endDate: null,
    refreshInterval: 120000,
    backgroundColor: COLOR_LIGHT_GRAY,
    color: COLOR_LIGHT_GRAY,
    height: Math.max(768, y * 60 + 60),
    width: 1024,
    canvasType: "CANVAS_TYPE_GRID",
    layoutType: "",
    widgetTemplates,
    warRoom: false,
    template: false,
  };
}

// ── RESTUI metric binding helpers ─────────────────────────────────────────────

function buildRestuiMetricSeries(
  w: WidgetDef,
  widgetId: number,
  widgetGuid: string,
  dashId: number,
): unknown[] | null {
  if (!w.metricPath) return null;
  const segments = w.metricPath.split("|");
  const logicalMetricName = segments[segments.length - 1] ?? w.metricPath;
  const hasSpecificBTs = w.btIds && w.btIds.length > 0;
  const rollupMetricData = w.type !== "TIMESERIES_GRAPH";

  return [{
    id: 0,
    version: 0,
    name: "Series 0",
    nameUnique: true,
    widgetGuid,
    widgetId,
    dashboardId: dashId,
    seriesType: "LINE",
    axisPosition: "LEFT",
    showRawMetricName: false,
    colorPalette: null,
    metricType: "BUSINESS_TRANSACTION",
    metricMatchCriteria: {
      applicationId: APP_ID,
      affectedEntityMatchCriteria: {
        aemcType: "BT_AFFECTED_EMC",
        type: hasSpecificBTs ? "SPECIFIC" : "ALL",
        componentIds: [],
        componentMatchCriteria: null,
        missingEntities: null,
        inverseOnSpecificEntities: false,
        businessTransactionIds: hasSpecificBTs ? w.btIds! : [],
        nameMatch: null,
        btTagInfoMatchCriteria: null,
      },
      evaluationScopeType: "TIER_AVERAGE",
      metricExpression: {
        type: "LEAF_METRIC_EXPRESSION",
        literalValueExpression: false,
        literalValue: 0,
        metricDefinition: {
          type: "LOGICAL_METRIC",
          logicalMetricName,
          scope: null,
          metricId: 0,
        },
        functionType: "VALUE",
        displayName: null,
        inputMetricText: false,
        inputMetricPath: `Root||` + w.metricPath.replace(/\|/g, "||"),
        extractedAppIdsFromAnalyticsMetric: null,
        value: 0,
      },
      rollupMetricData,
      expressionString: "",
      metricDisplayNameStyle: "DISPLAY_STYLE_AUTO",
      metricDisplayNameCustomFormat: null,
      metricDataFilter: { sortResultsAscending: false, maxResults: 20 },
      useActiveBaseline: false,
      baselineId: 0,
      includeAbove: false,
      includeBelow: false,
      includeBoth: false,
      includeBand12: false,
      includeBand23: false,
      includeBand34: false,
      includeBand45: false,
      includeShade: false,
      isIncludeAllInactiveServers: false,
      includeHistoricalNodes: false,
      excludeMaintenanceWindow: false,
      missingEntities: null,
    },
  }];
}

async function importViaServlet(exportJson: Record<string, unknown>): Promise<number | null> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([JSON.stringify(exportJson)], { type: "application/json" }),
    "dashboard.json",
  );
  const response = await appdPostFormData<unknown>("/controller/CustomDashboardImportExportServlet", form);

  // Tier 1: direct id / dashboardId
  if (response !== null && typeof response === "object" && !Array.isArray(response)) {
    const r = response as Record<string, unknown>;
    if (typeof r["id"] === "number") return r["id"];
    if (typeof r["dashboardId"] === "number") return r["dashboardId"];
    const nested = r["dashboard"];
    if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
      const n = nested as Record<string, unknown>;
      if (typeof n["id"] === "number") return n["id"];
    }
  }
  // Tier 2: array response
  if (Array.isArray(response) && response.length > 0) {
    const first = response[0] as Record<string, unknown>;
    if (typeof first["id"] === "number") return first["id"];
  }
  // Tier 3: list lookup by name
  const dashboards = await appdGetRaw<any[]>("/controller/restui/dashboards/getAllDashboardsByType/false");
  const found = Array.isArray(dashboards) ? dashboards.find((d: any) => d.name === DASH_NAME) : undefined;
  return found?.id ?? null;
}

async function bindMetricWidgets(dashId: number, metricWidgets: WidgetDef[]): Promise<void> {
  const toUpdate = metricWidgets.filter(w => w.metricPath !== undefined);
  if (toUpdate.length === 0) return;

  const widgetByTitle = new Map<string, WidgetDef>();
  for (const w of toUpdate) widgetByTitle.set(w.title, w);

  const dash = await appdGetRaw<Record<string, unknown>>(
    `/controller/restui/dashboards/dashboardIfUpdated/${dashId}/-1`,
  );
  const dashWidgets = (dash["widgets"] as Array<Record<string, unknown>>) ?? [];

  let hasChanges = false;
  const updatedWidgets = dashWidgets.map((w) => {
    const input = widgetByTitle.get(w["title"] as string);
    if (!input) return w;
    const criteria = buildRestuiMetricSeries(input, w["id"] as number, w["guid"] as string, dashId);
    if (!criteria) return w;
    hasChanges = true;
    return { ...w, widgetsMetricMatchCriterias: criteria };
  });

  if (!hasChanges) return;
  await appdPost("/controller/restui/dashboards/updateDashboard", { ...dash, widgets: updatedWidgets });
  console.log(`  Bound metric criteria for ${toUpdate.length} widgets`);
}

// ── Create Dashboard ──────────────────────────────────────────────────────────

console.log(`\nBuilding dashboard: "${DASH_NAME}"`);
console.log(`Widgets: ${widgets.length}`);
console.log(`Canvas height: ${Math.max(768, y * 60 + 60)}px`);

// Delete any existing dashboard with the same name
const existing = await appdGetRaw<any[]>("/controller/restui/dashboards/getAllDashboardsByType/false");
if (Array.isArray(existing)) {
  const dupes = existing.filter((d: any) => d.name === DASH_NAME);
  if (dupes.length > 0) {
    console.log(`\nDeleting ${dupes.length} existing dashboard(s) named "${DASH_NAME}"...`);
    for (const d of dupes) {
      await appdPost("/controller/restui/dashboards/deleteDashboards", [d.id]);
      console.log(`  Deleted ID: ${d.id}`);
    }
  }
}

const exportWidgets = widgets.map((w, i) => buildExportWidget(w, i));
const exportPayload = buildExportEnvelope(exportWidgets);

console.log("\nStep 1: Importing dashboard via servlet...");
const dashId = await importViaServlet(exportPayload);
if (dashId == null) {
  console.error("ERROR: Failed to get dashboard ID after import");
  process.exit(1);
}
console.log(`  Dashboard created with ID: ${dashId}`);

console.log("\nStep 2: Binding metric criteria (RESTUI two-step)...");
const metricWidgets = widgets.filter(w => w.metricPath !== undefined);
await bindMetricWidgets(dashId, metricWidgets);

console.log(`\nDashboard URL: ${process.env["APPD_URL"]}/controller/#/location=DASHBOARD_DETAIL&dashboardId=${dashId}`);

// ── Verify each widget has data ───────────────────────────────────────────────
console.log("\n══════════════════════════════════════════════════════");
console.log("Step 3: Verifying widget data (last 60 min)...");
console.log("══════════════════════════════════════════════════════");

interface MetricResult {
  metricPath: string;
  metricValues: Array<{ value: number; count: number }> | null;
}

let pass = 0;
let fail = 0;
let skip = 0;

for (const w of widgets) {
  if (w.type === "TEXT") { skip++; continue; }
  if (w.type === "HEALTH_LIST") {
    console.log(`  ✓ [HEALTH_LIST] "${w.title}" — live widget (no metric check)`);
    skip++; continue;
  }

  if (!w.metricPath) { skip++; continue; }

  try {
    const data = await appdGet<MetricResult[]>(
      `/controller/rest/applications/${APP_ID}/metric-data`,
      {
        "metric-path": w.metricPath,
        "time-range-type": "BEFORE_NOW",
        "duration-in-mins": 60,
        rollup: true,
      },
    );

    const hasData = Array.isArray(data) &&
      data.length > 0 &&
      data.some(m => m.metricValues && m.metricValues.length > 0 &&
        m.metricValues.some(v => v.count > 0));

    if (hasData) {
      const val = data[0]?.metricValues?.[0]?.value ?? 0;
      console.log(`  ✓ [${w.type}] "${w.title}" — value=${val}`);
      pass++;
    } else {
      console.log(`  ✗ [${w.type}] "${w.title}" — NO DATA (metric: ${w.metricPath})`);
      fail++;
    }
  } catch (err: any) {
    console.log(`  ? [${w.type}] "${w.title}" — ERROR: ${err.message}`);
    fail++;
  }
}

console.log("\n══════════════════════════════════════════════════════");
console.log(`Verification summary:`);
console.log(`  ✓ Has data:   ${pass}`);
console.log(`  ✗ No data:    ${fail}`);
console.log(`  - Skipped:    ${skip} (TEXT + HEALTH_LIST)`);
console.log(`  Total widgets: ${widgets.length}`);
console.log("══════════════════════════════════════════════════════");
console.log(`\nDashboard ID: ${dashId}`);
console.log(`URL: ${process.env["APPD_URL"]}/controller/#/location=DASHBOARD_DETAIL&dashboardId=${dashId}`);
