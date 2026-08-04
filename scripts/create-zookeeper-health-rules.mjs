/**
 * Creates health rules + dashboard for ZOOKEEPER URL Monitor services on Kivity-Ultra-7.
 * WARNING rule  : Status != 4
 * CRITICAL rule : Response Code != 200
 * Dashboard: one HealthListWidget per rule, scoped via propertiesMap.selectedEntityIds
 */

import https from "https";
import { randomUUID } from "crypto";
import { tokenFormBody } from "./_appd-env.mjs";

const BASE      = "https://experience.saas.appdynamics.com";
const APP_NAME  = "Server & Infrastructure Monitoring";
const NODE_NAME = "Kivity-Ultra-7";
const ROOT_PATH = `Application Infrastructure Performance|Root|Individual Nodes|${NODE_NAME}|Custom Metrics|URL Monitor|ZOOKEEPER`;
const DASH_NAME = "ZOOKEEPER URL Monitor Health";

// ── HTTP ─────────────────────────────────────────────────────────────────────
function req(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + path);
    const b = body ? Buffer.from(typeof body === "string" ? body : JSON.stringify(body)) : null;
    const r = https.request({ hostname: u.hostname, port: 443, path: u.pathname + u.search, method,
      headers: { ...headers, ...(b ? { "Content-Length": b.length } : {}) }
    }, rr => {
      const cs = []; rr.on("data", c => cs.push(c));
      rr.on("end", () => { const d = Buffer.concat(cs).toString();
        try { resolve({ status: rr.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: rr.statusCode, body: d }); }
      });
    });
    r.on("error", reject); if (b) r.write(b); r.end();
  });
}

let _tok = null;
async function getToken() {
  if (_tok) return _tok;
  const r = await req("POST", "/controller/api/oauth/access_token",
    tokenFormBody(),
    { "Content-Type": "application/x-www-form-urlencoded" });
  _tok = r.body.access_token; return _tok;
}
async function appdGet(path) {
  const t = await getToken();
  return req("GET", path, null, { "Authorization": `Bearer ${t}`, "Accept": "application/json" });
}
async function appdPost(path, body) {
  const t = await getToken();
  return req("POST", path, body, { "Authorization": `Bearer ${t}`, "Accept": "application/json", "Content-Type": "application/json" });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Import servlet ────────────────────────────────────────────────────────────
async function importServlet(dashboardJson) {
  const t = await getToken();
  const boundary = `----AppdBoundary${randomUUID().replace(/-/g, "")}`;
  const CRLF = "\r\n";
  const fileBody = JSON.stringify(dashboardJson, null, 2);
  const body = Buffer.from([
    `--${boundary}${CRLF}`,
    `Content-Disposition: form-data; name="file"; filename="dashboard.json"${CRLF}`,
    `Content-Type: application/json${CRLF}`,
    CRLF, fileBody, CRLF, `--${boundary}--${CRLF}`,
  ].join(""), "utf8");
  return new Promise((resolve, reject) => {
    const u = new URL(`${BASE}/controller/CustomDashboardImportExportServlet`);
    const r = https.request({ hostname: u.hostname, port: 443, path: u.pathname, method: "POST",
      headers: { "Authorization": `Bearer ${t}`, "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length }
    }, rr => {
      const cs = []; rr.on("data", c => cs.push(c));
      rr.on("end", () => { const d = Buffer.concat(cs).toString();
        try { resolve({ status: rr.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: rr.statusCode, body: d }); }
      });
    });
    r.on("error", reject); r.write(body); r.end();
  });
}

// ── Colors ────────────────────────────────────────────────────────────────────
const C_WHITE      = 16777215;
const C_LIGHT_GRAY = 15856629;
const C_DARK       = 1646891;
const C_BORDER     = 14408667;

// ── Widget builder (propertiesMap.selectedEntityIds = ruleId — discovered from UI) ──
function healthListWidget(title, ruleId, x, y, w, h) {
  return {
    widgetType: "HealthListWidget", title,
    height: h, width: w, minHeight: 0, minWidth: 0, x, y,
    label: null, description: null, drillDownUrl: null,
    openUrlInCurrentTab: false, useMetricBrowserAsDrillDown: true, drillDownActionType: null,
    backgroundColor: C_WHITE, backgroundColors: null,
    backgroundColorsStr: `${C_WHITE},${C_WHITE}`,
    color: C_DARK, fontSize: 11, useAutomaticFontSize: false,
    borderEnabled: true, borderThickness: 1, borderColor: C_BORDER, backgroundAlpha: 1,
    showValues: false, formatNumber: true, numDecimals: 0, removeZeros: true,
    compactMode: false, showTimeRange: false, renderIn3D: false,
    showLegend: null, legendPosition: null, legendColumnCount: null,
    timeRangeSpecifierType: "UNKNOWN", startTime: null, endTime: null,
    minutesBeforeAnchorTime: 15, isGlobal: true,
    propertiesMap: { selectedEntityIds: String(ruleId) },
    dataSeriesTemplates: null,
    applicationReference: {
      applicationName: APP_NAME, entityType: "APPLICATION", entityName: APP_NAME,
      scopingEntityType: null, scopingEntityName: null, subtype: null, uniqueKey: null,
    },
    entityReferences: [],
    entityType: "POLICY",
    entitySelectionType: null,
    iconSize: 18, iconPosition: "LEFT",
    showSearchBox: false, showList: true, showListHeader: false,
    showBarPie: true, showPie: true,
    showCurrentHealthStatus: false, innerRadius: 0, aggregationType: "RATIO",
  };
}

function buildDashboard(rules) {
  const COLS = 6, W = 2, H = 2;
  const widgets = rules.map(({ name, id }, i) => {
    const col = i % COLS, row = Math.floor(i / COLS);
    return healthListWidget(name, id, col * W, row * H, W, H);
  });
  const rows  = Math.ceil(rules.length / COLS);
  const dashH = Math.max(rows * H * 80 + 120, 400);
  return {
    schemaVersion: null, dashboardFormatVersion: "4.0",
    name: DASH_NAME,
    description: `ZOOKEEPER URL Monitor health — one widget per health rule (auto-generated)`,
    properties: null, templateEntityType: "APPLICATION_COMPONENT_NODE",
    associatedEntityTemplates: null, timeRangeSpecifierType: "GLOBAL",
    minutesBeforeAnchorTime: -1, startDate: null, endDate: null,
    refreshInterval: 60000, backgroundColor: C_LIGHT_GRAY, color: C_LIGHT_GRAY,
    height: dashH, width: 1440, canvasType: "CANVAS_TYPE_GRID", layoutType: "",
    widgetTemplates: widgets, warRoom: false, template: false,
  };
}

// ── Health rule payload builder (SIM / CUSTOM entity type) ────────────────────
function buildHealthRule(name, appId, metricPath, operator, threshold, severity) {
  const condition = {
    name: `${operator === "NOT_EQUALS" ? "!=" : operator} ${threshold}`,
    shortName: "A",
    evaluateToTrueOnNoData: false, violationStatusOnNoData: "UNKNOWN",
    wildcardMetricMatchType: "DEFAULT_ALL_METRIC_PATH",
    evalDetail: {
      evalDetailType: "SINGLE_METRIC",
      metricAggregateFunction: "VALUE",
      metricPath,
      metricEvalDetail: {
        metricEvalDetailType: "SPECIFIC_TYPE",
        compareCondition: operator,
        compareValue: threshold,
      },
      inputMetricText: false,
    },
    triggerEnabled: false, minimumTriggers: 1,
  };
  const criteria = {
    conditionAggregationType: "ALL",
    conditionExpression: null,
    conditions: [condition],
    evalMatchingCriteria: { matchType: "ANY", value: null },
  };
  return {
    name, enabled: true,
    useDataFromLastNMinutes: 5, waitTimeAfterViolation: 5,
    scheduleName: "Always",
    splitEventsByMetrics: false,
    affects: {
      affectedEntityType: "CUSTOM",
      affectedEntityScope: {
        entityScope: "SPECIFIC_ENTITY_PERFORMANCE",
        entityType: "SERVER",
        affectedEntityName: NODE_NAME,
      },
    },
    evalCriterias: severity === "CRITICAL"
      ? { criticalCriteria: criteria, warningCriteria: null }
      : { criticalCriteria: null, warningCriteria: criteria },
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log("=== ZOOKEEPER URL Monitor — health rules + dashboard ===\n");

// 1. Get app ID
const appR = await appdGet(`/controller/rest/applications/${encodeURIComponent(APP_NAME)}?output=JSON`);
const appId = appR.body?.[0]?.id;
if (!appId) { console.error("App not found"); process.exit(1); }
console.log(`App: "${APP_NAME}" → ID ${appId}`);

// 2. Browse metric tree
console.log(`\nBrowsing metric tree: ${ROOT_PATH}`);
async function browse(path, depth = 0) {
  const r = await appdGet(`/controller/rest/applications/${encodeURIComponent(APP_NAME)}/metrics?metric-path=${encodeURIComponent(path)}&output=JSON`);
  if (!Array.isArray(r.body)) return [];
  const leaves = [];
  for (const item of r.body) {
    if (item.type === "folder" && depth < 4) {
      const ch = await browse(path + "|" + item.name, depth + 1);
      leaves.push(...ch);
    } else if (item.type !== "folder") {
      leaves.push({ path: path + "|" + item.name, name: item.name });
    }
  }
  return leaves;
}
const leaves = await browse(ROOT_PATH);
console.log(`Found ${leaves.length} leaf metrics`);

// 3. Group by service, find Status and ResponseCode metrics
const groups = new Map();
for (const l of leaves) {
  const parts = l.path.split("|");
  const metricName = parts[parts.length - 1];
  const parent = parts.slice(0, -1).join("|");
  if (!groups.has(parent)) groups.set(parent, {});
  const key = metricName.toLowerCase().replace(/\s+/g, "");
  groups.get(parent)[key] = { fullPath: l.path, name: metricName };
}

const services = [];
for (const [parent, metrics] of groups) {
  const statusKey  = Object.keys(metrics).find(k => k === "status");
  const respKey    = Object.keys(metrics).find(k => k.includes("responsecode") || k === "responsecode");
  const parts      = parent.split("|");
  const serviceName = parts[parts.length - 1];  // e.g. ZOOKEEPER_Plx2248p
  if (statusKey && respKey) {
    services.push({
      name: serviceName,
      statusPath: metrics[statusKey].fullPath,
      respCodePath: metrics[respKey].fullPath,
    });
  }
}
services.sort((a, b) => a.name.localeCompare(b.name));
console.log(`Services with Status + ResponseCode: ${services.length}`);
services.forEach(s => console.log(`  ${s.name}`));

if (services.length === 0) { console.error("No services found"); process.exit(1); }

// 4. Delete existing "URL: ZOOKEEPER*" health rules
console.log("\nCleaning up existing rules...");
const existingR = await appdGet(`/controller/alerting/rest/v1/applications/${appId}/health-rules`);
const existing  = (Array.isArray(existingR.body) ? existingR.body : [])
  .filter(r => r.name?.startsWith("URL: ZOOKEEPER"));
for (const r of existing) {
  await appdGet(`/controller/alerting/rest/v1/applications/${appId}/health-rules/${r.id}`); // verify exists
  const d = await req("DELETE", `/controller/alerting/rest/v1/applications/${appId}/health-rules/${r.id}`,
    null, { "Authorization": `Bearer ${await getToken()}`, "Accept": "application/json" });
  if (d.status === 200 || d.status === 204) console.log(`  Deleted: ${r.name}`);
}

// 5. Create health rules (warning: status!=4, critical: responseCode!=200)
console.log("\nCreating health rules...");
const createdRules = [];
for (const svc of services) {
  // WARNING: Status != 4
  const warnName = `URL: ZOOKEEPER/${svc.name} Status`;
  const warnPayload = buildHealthRule(warnName, appId, svc.statusPath, "NOT_EQUALS", 4, "WARNING");
  const warnR = await appdPost(`/controller/alerting/rest/v1/applications/${appId}/health-rules`, warnPayload);
  const warnId = warnR.body?.id;
  if (warnId) {
    console.log(`  ✓ WARNING  "${warnName}" → ID ${warnId}`);
    createdRules.push({ name: warnName, id: warnId });
  } else {
    console.error(`  ✗ "${warnName}":`, JSON.stringify(warnR.body).slice(0, 150));
  }
  await sleep(100);

  // CRITICAL: Response Code != 200
  const critName = `URL: ZOOKEEPER/${svc.name} ResponseCode`;
  const critPayload = buildHealthRule(critName, appId, svc.respCodePath, "NOT_EQUALS", 200, "CRITICAL");
  const critR = await appdPost(`/controller/alerting/rest/v1/applications/${appId}/health-rules`, critPayload);
  const critId = critR.body?.id;
  if (critId) {
    console.log(`  ✓ CRITICAL "${critName}" → ID ${critId}`);
    createdRules.push({ name: critName, id: critId });
  } else {
    console.error(`  ✗ "${critName}":`, JSON.stringify(critR.body).slice(0, 150));
  }
  await sleep(100);
}
console.log(`\nCreated ${createdRules.length} health rules`);

// 6. Delete existing dashboard
const dashListR = await appdGet(`/controller/restui/dashboards/getAllDashboardsByType/false`);
const oldDashes = (Array.isArray(dashListR.body) ? dashListR.body : []).filter(d => d.name === DASH_NAME);
if (oldDashes.length) {
  await appdPost(`/controller/restui/dashboards/deleteDashboards`, oldDashes.map(d => d.id));
  console.log(`Deleted old dashboard(s): ${oldDashes.map(d=>d.id).join(", ")}`);
}

// 7. Build + import dashboard
console.log(`\nBuilding dashboard with ${createdRules.length} widgets...`);
const dash = buildDashboard(createdRules);
const imp  = await importServlet(dash);

if (!imp.body?.success) {
  console.error("Import failed:", JSON.stringify(imp.body).slice(0, 300));
  process.exit(1);
}

let dashId = imp.body?.dashboard?.id ?? null;
if (!dashId) {
  const r2  = await appdGet(`/controller/restui/dashboards/getAllDashboardsByType/false`);
  dashId = (Array.isArray(r2.body) ? r2.body : []).find(d => d.name === DASH_NAME)?.id ?? null;
}
if (!dashId) { console.error("Could not find new dashboard ID"); process.exit(1); }

// 8. Fix entitySelectionType — import servlet leaves entitySelectionType=null + entityIds=[].
//    Working format: entitySelectionType="SPECIFIED" + entityIds=[ruleId] + properties=[].
console.log(`\nFixing HealthList widget scoping via RESTUI...`);
const ruiR  = await appdGet(`/controller/restui/dashboards/dashboardIfUpdated/${dashId}/-1`);
const ruiDash = ruiR.body;
for (const w of (ruiDash.widgets ?? [])) {
  if (w.type !== "HEALTH_LIST") continue;
  const prop = (w.properties ?? []).find(p => p.name === "selectedEntityIds");
  if (!prop) continue;
  const ruleId = parseInt(prop.value, 10);
  if (!isNaN(ruleId)) {
    w.entitySelectionType = "SPECIFIED";
    w.entityIds = [ruleId];
    w.properties = [];
  }
}
const patchR = await appdPost(`/controller/restui/dashboards/updateDashboard`, ruiDash);
if (patchR.status === 200) {
  console.log(`✓ HealthList widgets scoped to individual rules`);
} else {
  console.error(`entityIds patch failed: HTTP ${patchR.status}`, JSON.stringify(patchR.body).slice(0, 200));
}

console.log(`\n✓ Dashboard created → ID ${dashId}`);
console.log(`🔗 ${BASE}/controller/#/location=DASHBOARD_DETAIL&timeRange=last_15_minutes.BEFORE_NOW.-1.-1.60&dashboardId=${dashId}`);
