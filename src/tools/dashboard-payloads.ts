/**
 * Pure payload builders for AppDynamics dashboards.
 *
 * Two widget format systems (do not mix):
 *   - Export format: consumed by POST /controller/CustomDashboardImportExportServlet
 *       widgetType: "GraphWidget", metrics in dataSeriesTemplates, top-level widgetTemplates
 *   - RESTUI format: consumed by /controller/restui/dashboards/createDashboard|updateDashboard
 *       type: "TIMESERIES_GRAPH", metrics in widgetsMetricMatchCriterias, top-level widgets
 *
 * Everything here is pure (no I/O) so it can be unit-tested against fixtures
 * captured from real, working dashboards (see test/fixtures/).
 *
 * Ground-truth facts baked into these builders (verified against the live API):
 *   - Valid RESTUI widget types: ANALYTICS, FLOWMAP, GAUGE, HEALTH_LIST, IFRAME,
 *     IMAGE, ISSUE_TRACKING, LABEL, LIST, LOG_TAIL, METRIC_LABEL,
 *     MULTI_SERIES_HEALTH_STATUS, PIE, STATUS_LIGHT, STREAMING_GRAPH, SUPER,
 *     TIMESERIES_GRAPH.  "TEXT" and "METRIC_VALUE" are NOT valid and get 400.
 *   - HEALTH_LIST scoping: entitySelectionType "SPECIFIED" + entityIds (health
 *     rule ids) + entityType "POLICY"; "ALL" to show every rule of the app.
 *   - BT metrics persist as BT_AFFECTED_EMC / TIER_AVERAGE with the category+leaf
 *     path ("Root||Business Transaction Performance||<leaf>") and btIds.
 *   - All other metrics use the typed-metric-path mode the UI produces when you
 *     type an absolute path: inputMetricText=true, plain single-pipe path,
 *     metricType null, evaluationScopeType null, INFRASTRUCTURE_AFFECTED_EMC /
 *     NODES / ANY as the (ignored) entity criteria.
 */

// ── Colors ────────────────────────────────────────────────────────────────────

export const COLOR_WHITE = 16777215; // #FFFFFF
export const COLOR_LIGHT_GRAY = 15856629; // #F1F1F5
export const COLOR_DARK = 1646891; // #19222B
export const COLOR_BORDER = 14408667; // #DBDBDB

// ── Widget input (MCP-facing shape) ───────────────────────────────────────────

export interface WidgetInput {
  type: string;
  title: string;
  height: number;
  width: number;
  x: number;
  y: number;
  applicationId?: number;
  applicationName?: string;
  metricPath?: string;
  entityType?: string;
  text?: string;
  label?: string;
  description?: string;
  adqlQuery?: string;
  btIds?: number[];
  tierIds?: number[];
  healthRuleIds?: number[];
  /** HEALTH_LIST display: render as pie/donut instead of the status bar. */
  showPie?: boolean;
  /** HEALTH_LIST display: donut hole radius (0 = solid pie, ~30-40 = donut). */
  innerRadius?: number;
  /** HEALTH_LIST display: show the rule list under the chart. Default true. */
  showList?: boolean;
}

// ── Metric path classification ────────────────────────────────────────────────

export type MetricClass = "BT" | "APP" | "INFRA";

/** Node-relative metric path prefixes served by the machine/app agent. */
const NODE_RELATIVE_PREFIXES = [
  "Hardware Resources|",
  "JVM|",
  "CLR|",
  "Agent|",
  "Memory|",
  "Process|",
  "Custom Metrics|",
];

/**
 * Classify a metric path into one of the three widgetData query shapes that
 * actually return data (verified live against POST /restui/dashboards/widgetData):
 *
 *   BT    — "Business Transaction Performance|…": BT_AFFECTED_EMC criteria with
 *           btIds support, path stored as Root||Business Transaction Performance||<leaf>.
 *   APP   — application-scope categories (Overall Application Performance,
 *           Service Endpoints, Backends, Errors, …): OVERALL_AFFECTED_EMC with
 *           type APPLICATION (or SPECIFIC_TIERS + componentIds when tierIds are
 *           given), path stored as Root||<category>||<rest>. This resolves the
 *           true application/tier aggregate (BTM|Application Summary|…);
 *           BT-style criteria for these paths render one series per BT instead.
 *   INFRA — node metrics (JVM, Hardware Resources, Agent, Custom Metrics, or an
 *           "Application Infrastructure Performance|<tier>|<rest>" path):
 *           INFRASTRUCTURE_AFFECTED_EMC / NODES / ANY with the NODE-RELATIVE path
 *           typed as text. Absolute AIP paths return no data in either BT or
 *           typed-absolute form — the node-relative rest is required.
 */
export function classifyMetricPath(path: string): MetricClass {
  if (path.startsWith("Business Transaction Performance")) return "BT";
  if (path.startsWith("Application Infrastructure Performance|")) return "INFRA";
  if (NODE_RELATIVE_PREFIXES.some((p) => path.startsWith(p))) return "INFRA";
  return "APP";
}

/**
 * Node-relative form of an INFRA metric path: strips the
 * "Application Infrastructure Performance|<tier>|" prefix when present
 * (widgetData resolves node metrics only by their node-relative path).
 */
export function toNodeRelativePath(path: string): string {
  if (!path.startsWith("Application Infrastructure Performance|")) return path;
  const segments = path.split("|");
  // [ "Application Infrastructure Performance", "<tier>", ...rest ]
  return segments.slice(2).join("|") || path;
}

// ── RESTUI widget type mapping ───────────────────────────────────────────────

/** Friendly/legacy names → valid RESTUI widget type enum values. */
const RESTUI_TYPE_MAP: Record<string, string> = {
  TEXT: "LABEL",
  TextWidget: "LABEL",
  LABEL: "LABEL",
  METRIC_VALUE: "METRIC_LABEL",
  MetricValue: "METRIC_LABEL",
  MetricLabelWidget: "METRIC_LABEL",
  METRIC_LABEL: "METRIC_LABEL",
  TIMESERIES_GRAPH: "TIMESERIES_GRAPH",
  GraphWidget: "TIMESERIES_GRAPH",
  AdvancedGraph: "TIMESERIES_GRAPH",
  HEALTH_LIST: "HEALTH_LIST",
  HealthListWidget: "HEALTH_LIST",
  PIE: "PIE",
  PieWidget: "PIE",
  GAUGE: "GAUGE",
  GaugeWidget: "GAUGE",
  ANALYTICS: "ANALYTICS",
  AnalyticsWidget: "ANALYTICS",
  IMAGE: "IMAGE",
  ImageWidget: "IMAGE",
};

export function toRestuiWidgetType(type: string): string {
  return RESTUI_TYPE_MAP[type] ?? type;
}

// ── RESTUI metric series builder ─────────────────────────────────────────────

/**
 * Build a widgetsMetricMatchCriterias entry for RESTUI updateDashboard.
 *
 * IMPORTANT: widgetId and widgetGuid must be the server-assigned values from a
 * saved widget — never client-generated placeholders (the API 500s otherwise).
 *
 * BT paths mirror how the UI persists BT metrics (dashboard 6471 ground truth).
 * All other paths mirror the typed-absolute-path form (dashboard 8045 ground
 * truth) — binding non-BT metrics as BT_AFFECTED_EMC yields empty widgets.
 */
export function buildRestuiMetricSeries(
  w: WidgetInput,
  widgetId: number,
  widgetGuid: string,
  dashboardId: number,
): Record<string, unknown>[] | null {
  if (!w.metricPath || !w.applicationId) return null;

  const restuiType = toRestuiWidgetType(w.type);
  // TIMESERIES_GRAPH needs individual points; value widgets aggregate to one number.
  const rollupMetricData = restuiType !== "TIMESERIES_GRAPH";

  const metricClass = classifyMetricPath(w.metricPath);

  let metricType: string | null;
  let affectedEntityMatchCriteria: Record<string, unknown>;
  let evaluationScopeType: string | null;
  let metricExpression: Record<string, unknown>;

  const segments = w.metricPath.split("|");
  const leaf = segments[segments.length - 1] ?? w.metricPath;

  // A BT-category path without specific btIds means "across all BTs" — the
  // app aggregate. The BT_AFFECTED_EMC/ALL form renders one series per BT on
  // graphs and "--" on labels, so route it through the OVERALL shape instead.
  const hasSpecificBTs = w.btIds !== undefined && w.btIds.length > 0;
  const effectiveClass =
    metricClass === "BT" && !hasSpecificBTs ? "APP" : metricClass;

  if (effectiveClass === "BT") {
    // BT scoping comes from businessTransactionIds; only the metric leaf
    // follows the category in the stored path.
    metricType = "BUSINESS_TRANSACTION";
    evaluationScopeType = "TIER_AVERAGE";
    affectedEntityMatchCriteria = {
      aemcType: "BT_AFFECTED_EMC",
      type: hasSpecificBTs ? "SPECIFIC" : "ALL",
      componentIds: [],
      componentMatchCriteria: null,
      missingEntities: null,
      inverseOnSpecificEntities: false,
      businessTransactionIds: hasSpecificBTs ? w.btIds : [],
      nameMatch: null,
      btTagInfoMatchCriteria: null,
    };
    metricExpression = {
      type: "LEAF_METRIC_EXPRESSION",
      literalValueExpression: false,
      literalValue: 0,
      metricDefinition: {
        type: "LOGICAL_METRIC",
        logicalMetricName: leaf,
        scope: null,
        metricId: 0,
      },
      functionType: "VALUE",
      displayName: null,
      inputMetricText: false,
      inputMetricPath: `Root||Business Transaction Performance||${leaf}`,
      extractedAppIdsFromAnalyticsMetric: null,
      value: 0,
    };
  } else if (effectiveClass === "APP") {
    // Application/tier aggregate via OVERALL_AFFECTED_EMC — resolves
    // BTM|Application Summary|<metric> (the number the app dashboard shows).
    const hasTiers = w.tierIds !== undefined && w.tierIds.length > 0;
    const category = segments[0] ?? w.metricPath;
    const rest = segments.slice(1).join("|") || leaf;
    metricType = null;
    evaluationScopeType = null;
    affectedEntityMatchCriteria = {
      aemcType: "OVERALL_AFFECTED_EMC",
      type: hasTiers ? "SPECIFIC_TIERS" : "APPLICATION",
      componentIds: hasTiers ? w.tierIds : [],
      componentMatchCriteria: null,
      nodeMatchCriteria: null,
      missingEntities: null,
      inverseOnSpecificEntities: false,
    };
    metricExpression = {
      type: "LEAF_METRIC_EXPRESSION",
      literalValueExpression: false,
      literalValue: 0,
      metricDefinition: {
        type: "LOGICAL_METRIC",
        logicalMetricName: leaf,
        scope: null,
        metricId: 0,
      },
      functionType: "VALUE",
      displayName: null,
      inputMetricText: false,
      inputMetricPath: `Root||${category}||${rest}`,
      extractedAppIdsFromAnalyticsMetric: null,
      value: 0,
    };
  } else {
    // INFRA: node metrics resolve only via their NODE-RELATIVE path typed as
    // text with INFRASTRUCTURE_AFFECTED_EMC / NODES / ANY (absolute
    // "Application Infrastructure Performance|…" paths return no data).
    const nodePath = toNodeRelativePath(w.metricPath);
    metricType = null;
    evaluationScopeType = null;
    affectedEntityMatchCriteria = {
      aemcType: "INFRASTRUCTURE_AFFECTED_EMC",
      type: "NODES",
      componentIds: [],
      componentMatchCriteria: null,
      missingEntities: null,
      inverseOnSpecificEntities: false,
      nodeMatchCriteria: {
        nodeIds: null,
        componentIds: null,
        componentMatchCriteria: null,
        nodeNameMatchCriteria: null,
        nodeMetaInfoMatchCriteria: null,
        latestVmSystemProperties: null,
        latestEnvironmentVariables: null,
        tagNameValues: [],
        type: "ANY",
        nodeTypes: null,
        inverseOnSpecificEntities: false,
      },
    };
    metricExpression = {
      type: "LEAF_METRIC_EXPRESSION",
      literalValueExpression: false,
      literalValue: 0,
      metricDefinition: {
        type: "LOGICAL_METRIC",
        logicalMetricName: nodePath,
        scope: null,
        metricId: 0,
      },
      functionType: "VALUE",
      displayName: null,
      inputMetricText: true,
      inputMetricPath: nodePath,
      extractedAppIdsFromAnalyticsMetric: null,
      value: 0,
    };
  }

  return [
    {
      id: 0,
      version: 0,
      name: "Series 0",
      nameUnique: true,
      widgetGuid,
      widgetId,
      dashboardId,
      seriesType: "LINE",
      axisPosition: "LEFT",
      showRawMetricName: false,
      colorPalette: null,
      metricType,
      metricMatchCriteria: {
        applicationId: w.applicationId,
        affectedEntityMatchCriteria,
        evaluationScopeType,
        metricExpression,
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
    },
  ];
}

// ── RESTUI widget builder ─────────────────────────────────────────────────────

/**
 * Build a widget in the RESTUI dashboard API format (createDashboard/updateDashboard).
 * Metric criteria are NOT embedded — they must be bound in a second updateDashboard
 * call once the server has assigned the widget id/guid (see applyMetricCriteria).
 */
export function buildWidgetPayload(w: WidgetInput): Record<string, unknown> {
  const apiType = toRestuiWidgetType(w.type);

  const base: Record<string, unknown> = {
    title: w.title,
    type: apiType,
    height: w.height,
    width: w.width,
    x: w.x,
    y: w.y,
    label: w.title,
    description: w.description ?? null,
    drillDownUrl: null,
    openUrlInCurrentTab: false,
    useMetricBrowserAsDrillDown: true,
    drillDownActionType: null,
    backgroundColor: COLOR_WHITE,
    color: COLOR_DARK,
    fontSize: 12,
    useAutomaticFontSize: false,
    borderEnabled: false,
    borderThickness: 0,
    borderColor: COLOR_BORDER,
    backgroundAlpha: 1.0,
    showValues: false,
    formatNumber: true,
    numDecimals: 0,
    removeZeros: true,
    backgroundColors: [COLOR_WHITE, COLOR_WHITE],
    compactMode: false,
    showTimeRange: false,
    renderIn3D: false,
    isGlobal: true,
    properties: [],
    missingEntities: null,
    minHeight: 0,
    minWidth: 0,
    widgetsMetricMatchCriterias: null,
    timeRangeSpecifierType: "BEFORE_NOW",
    startTime: null,
    endTime: null,
    customTimeRange: null,
    minutesBeforeAnchorTime: 15,
  };

  // ── LABEL (text) widget ───────────────────────────────────────────────────
  if (apiType === "LABEL") {
    base.text = w.text ?? "";
    base.useMetricBrowserAsDrillDown = false;
    return base;
  }

  // ── HEALTH_LIST widget ────────────────────────────────────────────────────
  if (apiType === "HEALTH_LIST") {
    base.useMetricBrowserAsDrillDown = false;
    base.applicationId = w.applicationId ?? null;
    base.entityType = w.entityType ?? "POLICY";
    if (w.healthRuleIds !== undefined && w.healthRuleIds.length > 0) {
      base.entitySelectionType = "SPECIFIED";
      base.entityIds = w.healthRuleIds;
    } else {
      base.entitySelectionType = "ALL";
      base.entityIds = [];
    }
    base.iconSize = 20;
    base.iconPosition = "LEFT";
    base.showSearchBox = false;
    base.showList = w.showList ?? true;
    base.showListHeader = false;
    // showPie and showBarPie are mutually exclusive display modes
    base.showPie = w.showPie ?? false;
    base.showBarPie = !(w.showPie ?? false);
    base.innerRadius = w.innerRadius ?? 0;
    base.aggregationType = "RATIO";
    base.showCurrentHealthStatus = false;
    return base;
  }

  // ── TIMESERIES_GRAPH extras ───────────────────────────────────────────────
  if (apiType === "TIMESERIES_GRAPH") {
    base.showLegend = true;
    base.legendPosition = "POSITION_BOTTOM";
    base.legendColumnCount = 1;
    base.verticalAxisLabel = null;
    base.hideHorizontalAxis = null;
    base.horizontalAxisLabel = null;
    base.axisType = "LINEAR";
    base.stackMode = null;
    base.multipleYAxis = null;
    base.showEvents = null;
    base.eventFilter = null;
    base.interpolateDataGaps = false;
    base.showAllTooltips = null;
    base.staticThresholds = null;
  }

  // ── PIE extras ────────────────────────────────────────────────────────────
  if (apiType === "PIE") {
    base.showLabels = true;
    base.showLegend = true;
    base.legendPosition = "POSITION_BOTTOM";
    base.legendColumnCount = 1;
  }

  if (w.applicationId !== undefined) {
    base.applicationId = w.applicationId;
  }

  return base;
}

// ── Post-save patch helpers (pure cores of the bind steps) ────────────────────

type DashWidget = Record<string, unknown>;

export interface PatchResult {
  widgets: DashWidget[];
  changed: boolean;
}

/**
 * Fix HEALTH_LIST widgets on a saved dashboard so they actually display rules.
 *
 * Working recipe (confirmed against known-good dashboards 8541/6514/6471):
 *   entitySelectionType: "SPECIFIED", entityIds: [ruleIds], entityType: "POLICY",
 *   properties: []  — or entitySelectionType "ALL" when no specific rules wanted.
 *
 * Rule ids come from (in priority order):
 *   1. servlet-preserved properties[].selectedEntityIds
 *   2. widget's existing entityIds
 *   3. the caller's original healthRuleIds input, matched by widget title
 */
export function patchHealthListWidgets(
  dashWidgets: DashWidget[],
  sourceWidgets?: WidgetInput[],
): PatchResult {
  // Queue per title so duplicate titles pair 1:1 in order instead of last-wins
  const sourceQueues = new Map<string, WidgetInput[]>();
  for (const w of sourceWidgets ?? []) {
    if (toRestuiWidgetType(w.type) !== "HEALTH_LIST") continue;
    const q = sourceQueues.get(w.title);
    if (q) q.push(w);
    else sourceQueues.set(w.title, [w]);
  }

  let changed = false;
  const widgets = dashWidgets.map((w) => {
    if (w["type"] !== "HEALTH_LIST") return w;

    const source = sourceQueues.get(w["title"] as string)?.shift();

    // 1. Servlet-preserved property
    const props = (w["properties"] as Array<Record<string, unknown>> | null) ?? [];
    const prop = props.find((p) => p["name"] === "selectedEntityIds");
    let ruleIds: number[] = [];
    if (prop !== undefined) {
      ruleIds = String(prop["value"])
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n));
    }
    // 2. Already-present entityIds
    if (ruleIds.length === 0 && Array.isArray(w["entityIds"])) {
      ruleIds = (w["entityIds"] as number[]).filter((n) => typeof n === "number");
    }
    // 3. Caller's original input
    if (ruleIds.length === 0 && source?.healthRuleIds !== undefined) {
      ruleIds = source.healthRuleIds;
    }

    // A widget with no rule ids and no source input (e.g. arbitrary imported
    // dashboards) may be scoped intentionally in ways we can't see — leave it.
    if (ruleIds.length === 0 && source === undefined) return w;

    const patch: Record<string, unknown> = ruleIds.length > 0
      ? {
          entitySelectionType: "SPECIFIED",
          entityIds: ruleIds,
          // Preserve an existing entity type (e.g. TIER-scoped lists on import)
          entityType: (w["entityType"] as string | null) ?? source?.entityType ?? "POLICY",
          properties: [], // selectedEntityIds property is redundant once SPECIFIED+entityIds is set
        }
      : {
          entitySelectionType: "ALL",
          entityIds: [],
          entityType: (w["entityType"] as string | null) ?? "POLICY",
        };

    // Patch applicationId when the import servlet couldn't resolve the app
    const srcAppId = source?.applicationId;
    const currentAppId = w["applicationId"];
    if (srcAppId !== undefined && (currentAppId === null || currentAppId === undefined || currentAppId === 0)) {
      patch["applicationId"] = srcAppId;
    }

    // Re-apply display props from the caller's input (the import servlet
    // does not reliably preserve them)
    if (source?.showPie !== undefined) {
      patch["showPie"] = source.showPie;
      patch["showBarPie"] = !source.showPie;
    }
    if (source?.innerRadius !== undefined) patch["innerRadius"] = source.innerRadius;
    if (source?.showList !== undefined) patch["showList"] = source.showList;

    const needsChange = Object.entries(patch).some(
      ([k, v]) => JSON.stringify(w[k]) !== JSON.stringify(v),
    );
    if (!needsChange) return w;
    changed = true;
    return { ...w, ...patch };
  });

  return { widgets, changed };
}

/**
 * Bind metric criteria to saved widgets, matching dashboard widgets to the
 * caller's widget inputs by title and using the server-assigned id/guid.
 */
/** RESTUI widget types that can carry widgetsMetricMatchCriterias. */
const METRIC_WIDGET_TYPES = new Set(["TIMESERIES_GRAPH", "METRIC_LABEL", "PIE", "GAUGE"]);

export function applyMetricCriteria(
  dashWidgets: DashWidget[],
  sourceWidgets: WidgetInput[],
  dashboardId: number,
): PatchResult {
  // Queue per title so duplicate titles pair 1:1 in order instead of last-wins
  const sourceQueues = new Map<string, WidgetInput[]>();
  for (const w of sourceWidgets) {
    if (w.metricPath === undefined || w.applicationId === undefined) continue;
    const q = sourceQueues.get(w.title);
    if (q) q.push(w);
    else sourceQueues.set(w.title, [w]);
  }

  let changed = false;
  const widgets = dashWidgets.map((w) => {
    if (!METRIC_WIDGET_TYPES.has(w["type"] as string)) return w;
    const input = sourceQueues.get(w["title"] as string)?.shift();
    if (!input) return w;
    const criteria = buildRestuiMetricSeries(
      input,
      w["id"] as number,
      w["guid"] as string,
      dashboardId,
    );
    if (!criteria) return w;
    changed = true;
    return { ...w, widgetsMetricMatchCriterias: criteria };
  });

  return { widgets, changed };
}

// ── Export format builders (import-servlet leg) ───────────────────────────────

const EXPORT_TYPE_MAP: Record<string, string> = {
  TIMESERIES_GRAPH: "GraphWidget",
  METRIC_VALUE: "MetricLabelWidget",
  METRIC_LABEL: "MetricLabelWidget",
  HEALTH_LIST: "HealthListWidget",
  TEXT: "TextWidget",
  LABEL: "TextWidget",
  PIE: "PieWidget",
  GAUGE: "GaugeWidget",
  ANALYTICS: "AnalyticsWidget",
  // pass-through if already in export class-name form
  GraphWidget: "GraphWidget",
  MetricLabelWidget: "MetricLabelWidget",
  HealthListWidget: "HealthListWidget",
  TextWidget: "TextWidget",
  PieWidget: "PieWidget",
  GaugeWidget: "GaugeWidget",
  AnalyticsWidget: "AnalyticsWidget",
};

/**
 * Build a widget in the AppDynamics export/import JSON format — what the UI's
 * "Export Dashboard" produces. Metric bindings embedded here are dropped or
 * mangled by the import servlet, so callers re-bind via applyMetricCriteria
 * after import; the dataSeriesTemplates below only need to be import-valid.
 */
export function buildExportWidgetPayload(w: WidgetInput, index: number): Record<string, unknown> {
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
    description: w.description ?? null,
    drillDownUrl: null,
    openUrlInCurrentTab: false,
    useMetricBrowserAsDrillDown: widgetType !== "TextWidget" && widgetType !== "AnalyticsWidget",
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

  // ── TextWidget ────────────────────────────────────────────────────────────
  if (widgetType === "TextWidget") {
    base.useMetricBrowserAsDrillDown = false;
    base.text = w.text ?? "";
    return base;
  }

  // ── AnalyticsWidget ───────────────────────────────────────────────────────
  if (widgetType === "AnalyticsWidget") {
    base.useMetricBrowserAsDrillDown = false;
    base.showValues = false;
    base.formatNumber = true;
    base.numDecimals = 2;
    base.removeZeros = true;
    base.borderColor = 0;
    base.color = 3342336; // AppDynamics analytics blue
    base.backgroundColorsStr = null;
    base.adqlQueryList = w.adqlQuery ? [w.adqlQuery] : [];
    base.analyticsWidgetType = "TABLE";
    base.searchMode = "ADVANCED";
    base.isStackingEnabled = false;
    base.legendsLayout = null;
    base.maxAllowedYAxisFields = 10;
    base.maxAllowedXAxisFields = 10;
    base.min = null;
    base.interval = null;
    base.max = null;
    base.intervalType = null;
    base.maxType = null;
    base.minType = null;
    base.showMinExtremes = false;
    base.showMaxExtremes = false;
    base.displayPercentileMarkers = false;
    base.percentileValue1 = null;
    base.percentileValue2 = null;
    base.percentileValue3 = null;
    base.percentileValue4 = null;
    base.isShowLogYAxis = false;
    base.resolution = null;
    base.dataFetchSize = null;
    base.percentileLine = null;
    base.timeRangeInterval = null;
    base.pollingInterval = null;
    base.unit = 0;
    base.isRawQuery = true;
    base.viewState = null;
    base.gridState = null;
    base.slmConfigId = null;
    base.bjId = null;
    base.showInverse = false;
    base.showHealth = false;
    base.align = "center";
    base.compareToOption = null;
    base.trailingPeriod = null;
    base.trailingPeriodUnit = null;
    base.isIncreaseGood = null;
    base.numberFormatOption = null;
    base.showUnivariateLabel = true;
    return base;
  }

  // ── HealthListWidget ──────────────────────────────────────────────────────
  if (widgetType === "HealthListWidget") {
    const appName = w.applicationName ?? String(w.applicationId ?? "");
    // applicationReference scopes the widget to this application
    base.applicationReference = appName
      ? {
          applicationName: appName,
          entityType: "APPLICATION",
          entityName: appName,
          scopingEntityType: null,
          scopingEntityName: null,
          subtype: null,
          uniqueKey: null,
        }
      : null;
    // The servlet only accepts propertiesMap.selectedEntityIds; the SPECIFIED +
    // entityIds recipe is applied afterwards via patchHealthListWidgets.
    base.entityType = w.entityType ?? "POLICY";
    base.entitySelectionType = null;
    base.entityReferences = [];
    if (w.healthRuleIds !== undefined && w.healthRuleIds.length > 0) {
      base.propertiesMap = { selectedEntityIds: w.healthRuleIds.join(",") };
    } else {
      base.propertiesMap = null;
    }
    base.iconSize = 18;
    base.iconPosition = "LEFT";
    base.showSearchBox = false;
    base.showList = w.showList ?? true;
    base.showListHeader = false;
    // showPie and showBarPie are mutually exclusive display modes
    base.showBarPie = !(w.showPie ?? false);
    base.showPie = w.showPie ?? false;
    base.showCurrentHealthStatus = false;
    base.innerRadius = w.innerRadius ?? 0;
    base.aggregationType = "RATIO";
    return base;
  }

  // ── Metric-based widgets (GaugeWidget, GraphWidget, MetricLabelWidget, PieWidget) ──
  if (w.metricPath) {
    const appName = w.applicationName ?? String(w.applicationId ?? "");
    // inputMetricPath uses || separators with Root||Applications||AppName|| prefix.
    const inputMetricPath =
      `Root||Applications||${appName}||` + w.metricPath.replace(/\|/g, "||");

    const isBT = classifyMetricPath(w.metricPath) === "BT";
    const metricType = isBT ? "BUSINESS_TRANSACTION" : "OVERALL_APPLICATION";
    const entityType = isBT ? "BUSINESS_TRANSACTION" : "APPLICATION";
    const evaluationScopeType = isBT ? "TIER_AVERAGE" : null;

    base.dataSeriesTemplates = [
      {
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
          applicationName: appName,
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
      },
    ];
  }

  // Widget-type-specific extra fields
  if (widgetType === "GaugeWidget") {
    base.showLabels = true;
    base.showPercentValues = null;
    base.useMinMaxValues = true;
    base.minValue = 0;
    base.maxValue = 100;
    base.invertColors = false;
  }

  if (widgetType === "MetricLabelWidget") {
    base.label = w.label ?? "${v}";
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

/**
 * Wrap widget array in the top-level envelope AppDynamics uses for exported
 * dashboard JSON files ("Export Dashboard" in the UI).
 */
export function buildExportDashboardEnvelope(
  name: string,
  description: string | null,
  height: number,
  width: number,
  widgetTemplates: Record<string, unknown>[],
): Record<string, unknown> {
  return {
    schemaVersion: null,
    dashboardFormatVersion: "4.0",
    name,
    description,
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
    height,
    width,
    canvasType: "CANVAS_TYPE_GRID",
    layoutType: "",
    widgetTemplates,
    warRoom: false,
    template: false,
  };
}
