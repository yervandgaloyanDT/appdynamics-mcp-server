/**
 * Rebuilds just the dashboard using the existing "URL: *" health rules already in AppD.
 * Two-step approach:
 *   1. Import via export servlet (creates 188 widgets, all "ALL" scope)
 *   2. RESTUI updateDashboard — sets entityIds per widget to scope each to its specific rule
 */

import https from "https";
import { randomUUID } from "crypto";

const BASE      = "https://experience.saas.appdynamics.com";
const APP_NAME  = "Server & Infrastructure Monitoring";
const DASH_NAME = "URL Monitor Service Health";

// ── HTTP ──────────────────────────────────────────────────────────────────────
function rawReq(method, urlStr, body, headers) {
  return new Promise((resolve, reject) => {
    const u   = new URL(urlStr);
    const buf = body ? Buffer.from(typeof body === "string" ? body : JSON.stringify(body)) : null;
    const r   = https.request({ hostname: u.hostname, port: 443, path: u.pathname + u.search, method,
      headers: { ...headers, ...(buf ? { "Content-Length": buf.length } : {}) }
    }, rr => {
      const cs = []; rr.on("data", c => cs.push(c));
      rr.on("end", () => { const d = Buffer.concat(cs).toString();
        try { resolve({ status: rr.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: rr.statusCode, body: d }); }
      });
    });
    r.on("error", reject); if (buf) r.write(buf); r.end();
  });
}

let _tok = null;
async function getToken() {
  if (_tok) return _tok;
  const r = await rawReq("POST", `${BASE}/controller/api/oauth/access_token`,
    "grant_type=client_credentials&client_id=mcpV2%40experience&client_secret=REDACTED-ROTATED-SECRET",
    { "Content-Type": "application/x-www-form-urlencoded" });
  _tok = r.body.access_token;
  return _tok;
}
async function appdGet(path) {
  const t = await getToken();
  return rawReq("GET", `${BASE}${path}`, null, { "Authorization": `Bearer ${t}`, "Accept": "application/json" });
}
async function appdPost(path, body) {
  const t = await getToken();
  return rawReq("POST", `${BASE}${path}`, body,
    { "Authorization": `Bearer ${t}`, "Accept": "application/json", "Content-Type": "application/json" });
}

// ── Import servlet ────────────────────────────────────────────────────────────
async function importServlet(dashboardJson) {
  const t        = await getToken();
  const boundary = `----AppdBoundary${randomUUID().replace(/-/g, "")}`;
  const CRLF     = "\r\n";
  const fileBody = JSON.stringify(dashboardJson, null, 2);
  const body     = Buffer.from([
    `--${boundary}${CRLF}`,
    `Content-Disposition: form-data; name="file"; filename="dashboard.json"${CRLF}`,
    `Content-Type: application/json${CRLF}`,
    CRLF, fileBody, CRLF,
    `--${boundary}--${CRLF}`,
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

// Export-format widget scoped to a specific health rule.
// Key discovered from UI: propertiesMap.selectedEntityIds = ruleId (string), entitySelectionType = null
function healthListWidget(title, ruleId, x, y, w, h) {
  return {
    widgetType: "HealthListWidget",
    title,
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
      applicationName: APP_NAME,
      entityType: "APPLICATION",
      entityName: APP_NAME,
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
    description: `URL Monitor health status — one widget per health rule (auto-generated)`,
    properties: null, templateEntityType: "APPLICATION_COMPONENT_NODE",
    associatedEntityTemplates: null, timeRangeSpecifierType: "GLOBAL",
    minutesBeforeAnchorTime: -1, startDate: null, endDate: null,
    refreshInterval: 60000, backgroundColor: C_LIGHT_GRAY, color: C_LIGHT_GRAY,
    height: dashH, width: 1440, canvasType: "CANVAS_TYPE_GRID", layoutType: "",
    widgetTemplates: widgets, warRoom: false, template: false,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log("=== Rebuild dashboard from existing health rules ===\n");

// 1. Get app ID
const appListR = await appdGet(`/controller/rest/applications/${encodeURIComponent(APP_NAME)}?output=JSON`);
const appId    = appListR.body?.[0]?.id;
if (!appId) { console.error("App not found"); process.exit(1); }
console.log(`App: "${APP_NAME}" → ID ${appId}`);

// 2. Fetch all health rules, filter for "URL: *"
const rulesR   = await appdGet(`/controller/alerting/rest/v1/applications/${appId}/health-rules`);
const allRules = Array.isArray(rulesR.body) ? rulesR.body : [];
const urlRules = allRules.filter(r => r.name && r.name.startsWith("URL: "));
urlRules.sort((a, b) => a.name.localeCompare(b.name));
console.log(`Found ${urlRules.length} "URL: *" health rules`);

if (urlRules.length === 0) {
  console.error("No URL health rules found. Run create-kivity-health-rules.mjs first.");
  process.exit(1);
}


// 3. Delete any existing dashboard with the same name (use correct POST endpoint)
const dashListR = await appdGet(`/controller/restui/dashboards/getAllDashboardsByType/false`);
const existing  = (Array.isArray(dashListR.body) ? dashListR.body : []).filter(d => d.name === DASH_NAME);
if (existing.length > 0) {
  const ids = existing.map(d => d.id);
  const dr  = await appdPost(`/controller/restui/dashboards/deleteDashboards`, ids);
  console.log(`Deleted existing dashboard(s) ${ids.join(",")}: HTTP ${dr.status}`);
}

// 4. Build + import dashboard (step 1: plain "ALL" scope — import servlet only accepts this)
console.log(`\nStep 1: Importing dashboard with ${urlRules.length} widgets…`);
const dash = buildDashboard(urlRules.map(r => ({ name: r.name, id: r.id })));
const imp  = await importServlet(dash);

if (!imp.body?.success) {
  console.error("Import failed:", JSON.stringify(imp.body).slice(0, 300));
  process.exit(1);
}

// Find the new dashboard ID
let dashId = imp.body?.dashboard?.id ?? null;
if (!dashId) {
  const r2    = await appdGet(`/controller/restui/dashboards/getAllDashboardsByType/false`);
  const found = (Array.isArray(r2.body) ? r2.body : []).find(d => d.name === DASH_NAME);
  dashId = found?.id ?? null;
}
if (!dashId) { console.error("Could not find new dashboard ID"); process.exit(1); }

// Fix HealthList widget scoping: import servlet leaves entitySelectionType=null + entityIds=[].
// Working format: entitySelectionType="SPECIFIED" + entityIds=[ruleId] + properties=[].
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
  console.error(`Patch failed: HTTP ${patchR.status}`, JSON.stringify(patchR.body).slice(0, 200));
}

console.log(`\n✓ Dashboard ready → ID ${dashId}`);
console.log(`🔗 ${BASE}/controller/#/location=DASHBOARD_DETAIL&timeRange=last_15_minutes.BEFORE_NOW.-1.-1.60&dashboardId=${dashId}`);
