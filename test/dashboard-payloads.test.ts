/**
 * Unit tests for the pure dashboard payload builders.
 *
 * Ground truth comes from real dashboards captured off the live controller
 * into test/fixtures/:
 *   - restui-6471.json  BT metric criteria as the AppD UI persists them
 *                       (BT_AFFECTED_EMC / SPECIFIC / TIER_AVERAGE)
 *   - restui-8045.json  absolute-path metric criteria (typed metric path):
 *                       INFRASTRUCTURE_AFFECTED_EMC / NODES / ANY,
 *                       metricType null, inputMetricText true, plain path
 *   - restui-8541.json  working HEALTH_LIST widgets:
 *                       entitySelectionType SPECIFIED + entityIds + POLICY
 *
 * Valid RESTUI widget type enum (interrogated from the live API):
 *   ANALYTICS, FLOWMAP, GAUGE, HEALTH_LIST, IFRAME, IMAGE, ISSUE_TRACKING,
 *   LABEL, LIST, LOG_TAIL, METRIC_LABEL, MULTI_SERIES_HEALTH_STATUS, PIE,
 *   STATUS_LIGHT, STREAMING_GRAPH, SUPER, TIMESERIES_GRAPH
 *   (note: no TEXT, no METRIC_VALUE)
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  classifyMetricPath,
  toNodeRelativePath,
  buildWidgetPayload,
  buildRestuiMetricSeries,
  buildExportWidgetPayload,
  buildExportDashboardEnvelope,
  patchHealthListWidgets,
  applyMetricCriteria,
  type WidgetInput,
} from "../src/tools/dashboard-payloads.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
function fixture(name: string): any {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf-8"));
}

const VALID_RESTUI_TYPES = [
  "ANALYTICS", "FLOWMAP", "GAUGE", "HEALTH_LIST", "IFRAME", "IMAGE",
  "ISSUE_TRACKING", "LABEL", "LIST", "LOG_TAIL", "METRIC_LABEL",
  "MULTI_SERIES_HEALTH_STATUS", "PIE", "STATUS_LIGHT", "STREAMING_GRAPH",
  "SUPER", "TIMESERIES_GRAPH",
];

function widget(overrides: Partial<WidgetInput> = {}): WidgetInput {
  return {
    type: "TIMESERIES_GRAPH",
    title: "Test Widget",
    height: 3,
    width: 4,
    x: 0,
    y: 0,
    ...overrides,
  };
}

// ── classifyMetricPath ────────────────────────────────────────────────────────

describe("classifyMetricPath", () => {
  it("classifies Business Transaction Performance paths as BT", () => {
    expect(classifyMetricPath("Business Transaction Performance|Business Transactions|Tier1|Checkout|Average Response Time (ms)")).toBe("BT");
    expect(classifyMetricPath("Business Transaction Performance|Average Response Time (ms)")).toBe("BT");
  });

  it("classifies application-scope categories as APP", () => {
    expect(classifyMetricPath("Overall Application Performance|Average Response Time (ms)")).toBe("APP");
    expect(classifyMetricPath("Overall Application Performance|Tier1|Average Response Time (ms)")).toBe("APP");
    expect(classifyMetricPath("Backends|Discovered backend call - db|Calls per Minute")).toBe("APP");
    expect(classifyMetricPath("Service Endpoints|Tier1|/api/foo|Calls per Minute")).toBe("APP");
    expect(classifyMetricPath("Errors|Tier1|Error|Errors per Minute")).toBe("APP");
  });

  it("classifies node metrics (absolute AIP or node-relative) as INFRA", () => {
    expect(classifyMetricPath("Application Infrastructure Performance|Tier1|JVM|Memory:Heap|Used %")).toBe("INFRA");
    expect(classifyMetricPath("Hardware Resources|CPU|%Busy")).toBe("INFRA");
    expect(classifyMetricPath("JVM|Process CPU Usage %")).toBe("INFRA");
    expect(classifyMetricPath("Agent|App|Availability")).toBe("INFRA");
    expect(classifyMetricPath("Custom Metrics|MyMetric")).toBe("INFRA");
  });
});

describe("toNodeRelativePath", () => {
  it("strips the AIP|<tier>| prefix", () => {
    expect(toNodeRelativePath("Application Infrastructure Performance|FrontEnd|JVM|Process CPU Usage %")).toBe("JVM|Process CPU Usage %");
    expect(toNodeRelativePath("Application Infrastructure Performance|Tier1|Hardware Resources|CPU|%Busy")).toBe("Hardware Resources|CPU|%Busy");
  });
  it("passes node-relative paths through unchanged", () => {
    expect(toNodeRelativePath("Hardware Resources|CPU|%Busy")).toBe("Hardware Resources|CPU|%Busy");
  });
});

// ── buildRestuiMetricSeries ───────────────────────────────────────────────────

describe("buildRestuiMetricSeries — BT metrics (ground truth: restui-6471)", () => {
  const w = widget({
    type: "METRIC_VALUE",
    metricPath: "Business Transaction Performance|Business Transactions|Tier1|Checkout|Average Response Time (ms)",
    applicationId: 48252,
    btIds: [123],
  });
  const series: any = buildRestuiMetricSeries(w, 555, "guid-555", 999)![0];

  it("uses BT_AFFECTED_EMC with SPECIFIC btIds and TIER_AVERAGE", () => {
    const aemc = series.metricMatchCriteria.affectedEntityMatchCriteria;
    expect(aemc.aemcType).toBe("BT_AFFECTED_EMC");
    expect(aemc.type).toBe("SPECIFIC");
    expect(aemc.businessTransactionIds).toEqual([123]);
    expect(series.metricMatchCriteria.evaluationScopeType).toBe("TIER_AVERAGE");
    expect(series.metricType).toBe("BUSINESS_TRANSACTION");
  });

  it("stores category + leaf metric path like the UI does (not the full BT path)", () => {
    const expr = series.metricMatchCriteria.metricExpression;
    expect(expr.inputMetricText).toBe(false);
    expect(expr.inputMetricPath).toBe("Root||Business Transaction Performance||Average Response Time (ms)");
    expect(expr.metricDefinition.logicalMetricName).toBe("Average Response Time (ms)");
  });

  it("routes BT paths WITHOUT btIds to the OVERALL app-aggregate shape (BT/ALL renders '--' on labels)", () => {
    const s: any = buildRestuiMetricSeries(widget({
      metricPath: "Business Transaction Performance|Average Response Time (ms)",
      applicationId: 48252,
    }), 1, "g", 2)![0];
    const aemc = s.metricMatchCriteria.affectedEntityMatchCriteria;
    expect(aemc.aemcType).toBe("OVERALL_AFFECTED_EMC");
    expect(aemc.type).toBe("APPLICATION");
    expect(s.metricMatchCriteria.metricExpression.inputMetricPath)
      .toBe("Root||Business Transaction Performance||Average Response Time (ms)");
  });

  it("binds server-assigned widget id/guid and dashboard id", () => {
    expect(series.widgetId).toBe(555);
    expect(series.widgetGuid).toBe("guid-555");
    expect(series.dashboardId).toBe(999);
  });
});

describe("buildRestuiMetricSeries — APP metrics (verified live via widgetData: OVERALL_AFFECTED_EMC)", () => {
  const w = widget({
    metricPath: "Overall Application Performance|Average Response Time (ms)",
    applicationId: 322,
  });
  const series: any = buildRestuiMetricSeries(w, 777, "guid-777", 888)![0];
  const mmc = series.metricMatchCriteria;

  it("uses OVERALL_AFFECTED_EMC/APPLICATION — the only shape returning the app aggregate", () => {
    expect(series.metricType).toBeNull();
    expect(mmc.evaluationScopeType).toBeNull();
    expect(mmc.affectedEntityMatchCriteria.aemcType).toBe("OVERALL_AFFECTED_EMC");
    expect(mmc.affectedEntityMatchCriteria.type).toBe("APPLICATION");
    expect(mmc.metricExpression.inputMetricText).toBe(false);
    expect(mmc.metricExpression.inputMetricPath).toBe("Root||Overall Application Performance||Average Response Time (ms)");
    expect(mmc.metricExpression.metricDefinition.logicalMetricName).toBe("Average Response Time (ms)");
  });

  it("scopes to tiers via SPECIFIC_TIERS + componentIds when tierIds given", () => {
    const s: any = buildRestuiMetricSeries(widget({
      metricPath: "Overall Application Performance|Average Response Time (ms)",
      applicationId: 322,
      tierIds: [176502],
    }), 1, "g", 2)![0];
    const aemc = s.metricMatchCriteria.affectedEntityMatchCriteria;
    expect(aemc.type).toBe("SPECIFIC_TIERS");
    expect(aemc.componentIds).toEqual([176502]);
  });

  it("applies OVERALL shape to other app-scope categories (Backends, Service Endpoints)", () => {
    const s: any = buildRestuiMetricSeries(widget({
      metricPath: "Backends|Discovered backend call - db|Calls per Minute",
      applicationId: 322,
    }), 1, "g", 2)![0];
    const mm = s.metricMatchCriteria;
    expect(mm.affectedEntityMatchCriteria.aemcType).toBe("OVERALL_AFFECTED_EMC");
    expect(mm.metricExpression.inputMetricPath).toBe("Root||Backends||Discovered backend call - db|Calls per Minute");
  });

  it("sets applicationId on the criteria", () => {
    expect(mmc.applicationId).toBe(322);
  });
});

describe("buildRestuiMetricSeries — INFRA metrics (verified live: node-relative typed path)", () => {
  it("strips the AIP|tier| prefix and types the node-relative path", () => {
    const s: any = buildRestuiMetricSeries(widget({
      metricPath: "Application Infrastructure Performance|FrontEnd|JVM|Process CPU Usage %",
      applicationId: 52210,
    }), 1, "g", 2)![0];
    const mmc = s.metricMatchCriteria;
    expect(s.metricType).toBeNull();
    expect(mmc.evaluationScopeType).toBeNull();
    expect(mmc.affectedEntityMatchCriteria.aemcType).toBe("INFRASTRUCTURE_AFFECTED_EMC");
    expect(mmc.affectedEntityMatchCriteria.type).toBe("NODES");
    expect(mmc.affectedEntityMatchCriteria.nodeMatchCriteria.type).toBe("ANY");
    expect(mmc.metricExpression.inputMetricText).toBe(true);
    expect(mmc.metricExpression.inputMetricPath).toBe("JVM|Process CPU Usage %");
  });

  it("matches the persisted shape of the working SIM fixture widget (restui-8045)", () => {
    const truth = fixture("restui-8045.json").widgets[0].widgetsMetricMatchCriterias[0];
    const s: any = buildRestuiMetricSeries(widget({
      metricPath: "Hardware Resources|CPU|%Busy",
      applicationId: 322,
    }), 1, "g", 2)![0];
    const mmc = s.metricMatchCriteria;
    const t = truth.metricMatchCriteria;
    expect(mmc.affectedEntityMatchCriteria.aemcType).toBe(t.affectedEntityMatchCriteria.aemcType);
    expect(mmc.affectedEntityMatchCriteria.type).toBe(t.affectedEntityMatchCriteria.type);
    expect(mmc.evaluationScopeType).toBe(t.evaluationScopeType);
    expect(mmc.metricExpression.inputMetricText).toBe(t.metricExpression.inputMetricText);
    expect(s.metricType).toBe(truth.metricType);
  });
});

describe("buildRestuiMetricSeries — rollup rule", () => {
  const path = "Overall Application Performance|Average Response Time (ms)";
  it("TIMESERIES_GRAPH gets time-series points (rollup=false)", () => {
    const s: any = buildRestuiMetricSeries(widget({ type: "TIMESERIES_GRAPH", metricPath: path, applicationId: 1 }), 1, "g", 2)![0];
    expect(s.metricMatchCriteria.rollupMetricData).toBe(false);
  });
  it("single-value widgets aggregate (rollup=true)", () => {
    for (const type of ["METRIC_VALUE", "GAUGE", "PIE"]) {
      const s: any = buildRestuiMetricSeries(widget({ type, metricPath: path, applicationId: 1 }), 1, "g", 2)![0];
      expect(s.metricMatchCriteria.rollupMetricData).toBe(true);
    }
  });
  it("returns null without metricPath or applicationId", () => {
    expect(buildRestuiMetricSeries(widget(), 1, "g", 2)).toBeNull();
    expect(buildRestuiMetricSeries(widget({ metricPath: path }), 1, "g", 2)).toBeNull();
  });
});

// ── buildWidgetPayload (RESTUI create/update format) ─────────────────────────

describe("buildWidgetPayload — RESTUI widget type enum", () => {
  it("maps friendly names to VALID RESTUI enum values (no TEXT / METRIC_VALUE)", () => {
    expect(buildWidgetPayload(widget({ type: "TEXT", text: "hi" })).type).toBe("LABEL");
    expect(buildWidgetPayload(widget({ type: "METRIC_VALUE" })).type).toBe("METRIC_LABEL");
    expect(buildWidgetPayload(widget({ type: "TIMESERIES_GRAPH" })).type).toBe("TIMESERIES_GRAPH");
    expect(buildWidgetPayload(widget({ type: "HEALTH_LIST" })).type).toBe("HEALTH_LIST");
  });

  it("always produces a type from the live enum, for every accepted alias", () => {
    const aliases = ["TEXT", "LABEL", "TextWidget", "METRIC_VALUE", "METRIC_LABEL", "MetricLabelWidget",
      "TIMESERIES_GRAPH", "GraphWidget", "AdvancedGraph", "HEALTH_LIST", "HealthListWidget",
      "PIE", "PieWidget", "GAUGE", "GaugeWidget"];
    for (const alias of aliases) {
      const built = buildWidgetPayload(widget({ type: alias, text: "x" }));
      expect(VALID_RESTUI_TYPES, `alias ${alias} → ${built.type}`).toContain(built.type);
    }
  });

  it("LABEL widgets carry their text", () => {
    expect(buildWidgetPayload(widget({ type: "TEXT", text: "Section 1" })).text).toBe("Section 1");
  });

  it("does not embed inline metric criteria (binding is a separate step)", () => {
    const built = buildWidgetPayload(widget({
      metricPath: "Overall Application Performance|Average Response Time (ms)",
      applicationId: 1,
    }));
    expect(built.widgetsMetricMatchCriterias).toBeNull();
  });
});

describe("buildWidgetPayload — HEALTH_LIST scoping (ground truth: restui-8541)", () => {
  it("scopes to specific rules with SPECIFIED + entityIds + POLICY", () => {
    const built = buildWidgetPayload(widget({ type: "HEALTH_LIST", applicationId: 322, healthRuleIds: [291021] }));
    expect(built.entitySelectionType).toBe("SPECIFIED");
    expect(built.entityIds).toEqual([291021]);
    expect(built.entityType).toBe("POLICY");
    expect(built.applicationId).toBe(322);
  });

  it("uses ALL when no rule ids given", () => {
    const built = buildWidgetPayload(widget({ type: "HEALTH_LIST", applicationId: 322 }));
    expect(built.entitySelectionType).toBe("ALL");
    expect(built.entityIds).toEqual([]);
    expect(built.entityType).toBe("POLICY");
  });

  it("matches the working fixture's field values", () => {
    const truth = fixture("restui-8541.json").widgets.find((w: any) => w.type === "HEALTH_LIST");
    const built = buildWidgetPayload(widget({ type: "HEALTH_LIST", applicationId: truth.applicationId, healthRuleIds: truth.entityIds }));
    expect(built.entitySelectionType).toBe(truth.entitySelectionType);
    expect(built.entityIds).toEqual(truth.entityIds);
    expect(built.entityType).toBe(truth.entityType);
  });

  it("defaults to the bar display (showBarPie, no pie, list shown)", () => {
    const built = buildWidgetPayload(widget({ type: "HEALTH_LIST", applicationId: 322 }));
    expect(built.showPie).toBe(false);
    expect(built.showBarPie).toBe(true);
    expect(built.showList).toBe(true);
    expect(built.innerRadius).toBe(0);
  });

  it("supports pie/donut display via showPie + innerRadius + showList", () => {
    const built = buildWidgetPayload(widget({
      type: "HEALTH_LIST", applicationId: 322, healthRuleIds: [1],
      showPie: true, innerRadius: 30, showList: false,
    }));
    expect(built.showPie).toBe(true);
    expect(built.showBarPie).toBe(false);
    expect(built.showList).toBe(false);
    expect(built.innerRadius).toBe(30);
  });
});

describe("buildExportWidgetPayload — HEALTH_LIST pie display", () => {
  it("carries the pie/donut display fields in the export format too", () => {
    const built: any = buildExportWidgetPayload(widget({
      type: "HEALTH_LIST", applicationId: 322, applicationName: "App",
      healthRuleIds: [1], showPie: true, innerRadius: 40,
    }), 0);
    expect(built.showPie).toBe(true);
    expect(built.showBarPie).toBe(false);
    expect(built.innerRadius).toBe(40);
  });
});

// ── patchHealthListWidgets ────────────────────────────────────────────────────

describe("patchHealthListWidgets", () => {
  const dashWidget = (over: Record<string, unknown> = {}) => ({
    type: "HEALTH_LIST",
    title: "Rule A",
    id: 10,
    guid: "g-10",
    applicationId: 322,
    entitySelectionType: null,
    entityIds: [],
    entityType: "POLICY",
    properties: [],
    ...over,
  });

  it("applies SPECIFIED recipe from servlet-preserved properties.selectedEntityIds", () => {
    const { widgets, changed } = patchHealthListWidgets(
      [dashWidget({ properties: [{ name: "selectedEntityIds", value: "291021" }] })],
    );
    expect(changed).toBe(true);
    expect(widgets[0]).toMatchObject({
      entitySelectionType: "SPECIFIED",
      entityIds: [291021],
      entityType: "POLICY",
      properties: [],
    });
  });

  it("falls back to source healthRuleIds when the servlet dropped the property", () => {
    const source = [widget({ type: "HEALTH_LIST", title: "Rule A", applicationId: 322, healthRuleIds: [291028, 291029] })];
    const { widgets, changed } = patchHealthListWidgets([dashWidget()], source);
    expect(changed).toBe(true);
    expect(widgets[0]).toMatchObject({
      entitySelectionType: "SPECIFIED",
      entityIds: [291028, 291029],
    });
  });

  it("sets ALL + POLICY when the caller's widget requested no specific rules", () => {
    const source = [widget({ type: "HEALTH_LIST", title: "Rule A", applicationId: 322 })];
    const { widgets, changed } = patchHealthListWidgets([dashWidget({ entityType: null })], source);
    expect(changed).toBe(true);
    expect(widgets[0]).toMatchObject({ entitySelectionType: "ALL", entityType: "POLICY" });
  });

  it("leaves widgets with no rule ids and no source input untouched (imported dashboards)", () => {
    const imported = dashWidget({ entitySelectionType: null, entityType: "TIER" });
    const { widgets, changed } = patchHealthListWidgets([imported]);
    expect(changed).toBe(false);
    expect(widgets[0]).toBe(imported);
  });

  it("preserves a non-POLICY entityType when applying the SPECIFIED recipe", () => {
    const tierScoped = dashWidget({
      entityType: "TIER",
      properties: [{ name: "selectedEntityIds", value: "42" }],
    });
    const { widgets } = patchHealthListWidgets([tierScoped]);
    expect(widgets[0]).toMatchObject({
      entitySelectionType: "SPECIFIED",
      entityIds: [42],
      entityType: "TIER",
    });
  });

  it("pairs duplicate titles 1:1 in order instead of last-wins", () => {
    const source = [
      widget({ type: "HEALTH_LIST", title: "HR", applicationId: 1, healthRuleIds: [101] }),
      widget({ type: "HEALTH_LIST", title: "HR", applicationId: 1, healthRuleIds: [202] }),
    ];
    const { widgets } = patchHealthListWidgets(
      [dashWidget({ title: "HR", id: 1 }), dashWidget({ title: "HR", id: 2 })],
      source,
    );
    expect(widgets[0]).toMatchObject({ entityIds: [101] });
    expect(widgets[1]).toMatchObject({ entityIds: [202] });
  });

  it("re-applies pie/donut display props from the source widget (servlet may drop them)", () => {
    const source = [widget({
      type: "HEALTH_LIST", title: "Rule A", applicationId: 322,
      healthRuleIds: [1], showPie: true, innerRadius: 30, showList: false,
    })];
    const { widgets } = patchHealthListWidgets(
      [dashWidget({ showPie: false, showBarPie: true, showList: true, innerRadius: 0 })],
      source,
    );
    expect(widgets[0]).toMatchObject({
      showPie: true,
      showBarPie: false,
      showList: false,
      innerRadius: 30,
    });
  });

  it("patches a missing applicationId from the source widget", () => {
    const source = [widget({ type: "HEALTH_LIST", title: "Rule A", applicationId: 322, healthRuleIds: [1] })];
    const { widgets } = patchHealthListWidgets([dashWidget({ applicationId: 0 })], source);
    expect(widgets[0]).toMatchObject({ applicationId: 322 });
  });

  it("leaves non-HEALTH_LIST widgets untouched", () => {
    const label = { type: "LABEL", title: "T", id: 1, guid: "g" };
    const { widgets } = patchHealthListWidgets([label, dashWidget()]);
    expect(widgets[0]).toBe(label);
  });

  it("reports changed=false when a widget is already correctly scoped", () => {
    const ok = dashWidget({ entitySelectionType: "SPECIFIED", entityIds: [291021] });
    const { changed } = patchHealthListWidgets([ok]);
    expect(changed).toBe(false);
  });
});

// ── applyMetricCriteria ───────────────────────────────────────────────────────

describe("applyMetricCriteria", () => {
  const source = [
    widget({
      title: "RT Graph",
      type: "TIMESERIES_GRAPH",
      metricPath: "Overall Application Performance|Average Response Time (ms)",
      applicationId: 322,
    }),
  ];
  const dashWidgets = [
    { type: "TIMESERIES_GRAPH", title: "RT Graph", id: 42, guid: "g-42", widgetsMetricMatchCriterias: null },
    { type: "LABEL", title: "Header", id: 43, guid: "g-43" },
  ];

  it("binds criteria to matching widgets using server-assigned id/guid", () => {
    const { widgets, changed } = applyMetricCriteria(dashWidgets, source, 900);
    expect(changed).toBe(true);
    const crit: any = (widgets[0] as any).widgetsMetricMatchCriterias;
    expect(Array.isArray(crit)).toBe(true);
    expect(crit[0].widgetId).toBe(42);
    expect(crit[0].widgetGuid).toBe("g-42");
    expect(crit[0].dashboardId).toBe(900);
  });

  it("returns changed=false when nothing matches", () => {
    const { changed } = applyMetricCriteria(dashWidgets, [], 900);
    expect(changed).toBe(false);
  });

  it("never attaches criteria to non-metric widget types sharing a title", () => {
    const dash = [
      { type: "HEALTH_LIST", title: "RT Graph", id: 1, guid: "g-1" },
      { type: "TIMESERIES_GRAPH", title: "RT Graph", id: 2, guid: "g-2", widgetsMetricMatchCriterias: null },
    ];
    const { widgets } = applyMetricCriteria(dash, source, 900);
    expect((widgets[0] as any).widgetsMetricMatchCriterias).toBeUndefined();
    const crit: any = (widgets[1] as any).widgetsMetricMatchCriterias;
    expect(crit[0].widgetId).toBe(2);
  });

  it("pairs duplicate titles 1:1 in order instead of last-wins", () => {
    const dupSource = [
      widget({ title: "Latency", metricPath: "Overall Application Performance|Average Response Time (ms)", applicationId: 1 }),
      widget({ title: "Latency", metricPath: "Overall Application Performance|Calls per Minute", applicationId: 1 }),
    ];
    const dash = [
      { type: "TIMESERIES_GRAPH", title: "Latency", id: 1, guid: "g-1" },
      { type: "TIMESERIES_GRAPH", title: "Latency", id: 2, guid: "g-2" },
    ];
    const { widgets } = applyMetricCriteria(dash, dupSource, 900);
    const path = (w: unknown): string =>
      (w as any).widgetsMetricMatchCriterias[0].metricMatchCriteria.metricExpression.inputMetricPath;
    expect(path(widgets[0])).toContain("Average Response Time");
    expect(path(widgets[1])).toContain("Calls per Minute");
  });
});

// ── buildExportWidgetPayload (import-servlet leg) ─────────────────────────────

describe("buildExportWidgetPayload", () => {
  it("emits TextWidget with text", () => {
    const built = buildExportWidgetPayload(widget({ type: "TEXT", text: "Header" }), 0);
    expect(built.widgetType).toBe("TextWidget");
    expect(built.text).toBe("Header");
  });

  it("HealthListWidget carries selectedEntityIds in propertiesMap for the servlet", () => {
    const built: any = buildExportWidgetPayload(
      widget({ type: "HEALTH_LIST", applicationId: 322, applicationName: "MyApp", healthRuleIds: [291021, 291022] }), 0);
    expect(built.widgetType).toBe("HealthListWidget");
    expect(built.entityType).toBe("POLICY");
    expect(built.propertiesMap).toEqual({ selectedEntityIds: "291021,291022" });
    expect(built.applicationReference.applicationName).toBe("MyApp");
  });

  it("BT metrics get BUSINESS_TRANSACTION series; others OVERALL_APPLICATION", () => {
    const bt: any = buildExportWidgetPayload(widget({
      type: "TIMESERIES_GRAPH",
      metricPath: "Business Transaction Performance|Business Transactions|T|B|Average Response Time (ms)",
      applicationId: 1, applicationName: "App",
    }), 0);
    expect(bt.dataSeriesTemplates[0].metricType).toBe("BUSINESS_TRANSACTION");

    const app: any = buildExportWidgetPayload(widget({
      type: "TIMESERIES_GRAPH",
      metricPath: "Overall Application Performance|Average Response Time (ms)",
      applicationId: 1, applicationName: "App",
    }), 0);
    expect(app.dataSeriesTemplates[0].metricType).toBe("OVERALL_APPLICATION");
  });
});

// ── buildExportDashboardEnvelope ─────────────────────────────────────────────

describe("buildExportDashboardEnvelope", () => {
  it("wraps widgets in a 4.0 grid-canvas envelope", () => {
    const env = buildExportDashboardEnvelope("Dash", "desc", 768, 1024, [{ widgetType: "TextWidget" }]);
    expect(env.dashboardFormatVersion).toBe("4.0");
    expect(env.canvasType).toBe("CANVAS_TYPE_GRID");
    expect(env.name).toBe("Dash");
    expect((env.widgetTemplates as unknown[]).length).toBe(1);
  });
});
