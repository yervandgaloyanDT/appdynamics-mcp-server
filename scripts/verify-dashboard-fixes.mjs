/**
 * End-to-end integration verification: drive the real MCP server over stdio,
 * create dashboards with the fixed code, then assert the persisted RESTUI
 * shapes match the known-good recipes.
 *
 * Requires env vars: APPD_URL, APPD_CLIENT_NAME, APPD_CLIENT_SECRET, APPD_ACCOUNT_NAME
 * Usage: node scripts/verify-dashboard-fixes.mjs [repoRoot]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import https from "https";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const REPO = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.APPD_URL;
const CLIENT_ID = `${process.env.APPD_CLIENT_NAME}@${process.env.APPD_ACCOUNT_NAME}`;
const SECRET = process.env.APPD_CLIENT_SECRET;
if (!BASE || !process.env.APPD_CLIENT_NAME || !SECRET) {
  console.error("Set APPD_URL, APPD_CLIENT_NAME, APPD_CLIENT_SECRET, APPD_ACCOUNT_NAME");
  process.exit(1);
}

function rawReq(method, urlStr, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const buf = body ? Buffer.from(typeof body === "string" ? body : JSON.stringify(body)) : null;
    const r = https.request({ hostname: u.hostname, port: 443, path: u.pathname + u.search, method,
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

// Raw controller access for assertions
const tokR = await rawReq("POST", `${BASE}/controller/api/oauth/access_token`,
  `grant_type=client_credentials&client_id=${encodeURIComponent(CLIENT_ID)}&client_secret=${encodeURIComponent(SECRET)}`,
  { "Content-Type": "application/x-www-form-urlencoded" });
const AUTH = { "Authorization": `Bearer ${tokR.body.access_token}`, "Accept": "application/json" };

// ── MCP client over stdio ─────────────────────────────────────────────────────
const transport = new StdioClientTransport({
  command: process.platform === "win32" ? "npx.cmd" : "npx",
  args: ["tsx", "src/index.ts"],
  cwd: REPO,
  env: { ...process.env },
});
const client = new Client({ name: "integration-verify", version: "1.0.0" });
await client.connect(transport);
console.log("MCP server connected.");

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content ?? []).map(c => c.text ?? "").join("\n");
  if (r.isError) throw new Error(`${name} failed: ${text.slice(0, 500)}`);
  return text;
}

let failures = 0;
function check(label, cond, detail = "") {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${cond ? "" : "  → " + detail}`);
  if (!cond) failures++;
}

// ── 1. Discover app + health rules ───────────────────────────────────────────
const appsText = await call("appd_get_applications", {});
const apps = JSON.parse(appsText.replace(/^[^[{]*/, ""));
// Prefer an app with live traffic so graphs visibly render data
const app = apps.find(a => /java-app2/i.test(a.name)) ?? apps.find(a => /java-app1/i.test(a.name)) ?? apps[0];
console.log(`\nUsing app: ${app.name} (${app.id})`);

const rulesText = await call("appd_get_health_rules", { application: String(app.id) });
let ruleIds = [];
try {
  const rules = JSON.parse(rulesText.replace(/^[^[{]*/, ""));
  ruleIds = (Array.isArray(rules) ? rules : rules.rules ?? []).map(r => r.id).filter(Boolean).slice(0, 2);
} catch { /* parse best-effort */ }
console.log(`Health rule ids: ${JSON.stringify(ruleIds)}`);

// SIM app 322 has the URL-monitor rules used by known-good dashboards
const simRules = await rawReq("GET", `${BASE}/controller/alerting/rest/v1/applications/322/health-rules`, null, AUTH);
const simRuleIds = (Array.isArray(simRules.body) ? simRules.body : []).map(r => r.id).slice(0, 2);
console.log(`SIM (322) rule ids: ${JSON.stringify(simRuleIds)}`);

// ── 2. Create the verification dashboard via the MCP tool ───────────────────
const DASH_NAME = `MCP Fix Verification ${Date.now()}`;
const widgets = [
  { type: "TEXT", title: "Header", text: "── MCP Fix Verification ──", width: 12, height: 1, x: 0, y: 0 },
  ...(simRuleIds.length ? [
    { type: "HEALTH_LIST", title: "HR Scoped", applicationId: 322, healthRuleIds: simRuleIds, width: 6, height: 2, x: 0, y: 1 },
  ] : []),
  { type: "HEALTH_LIST", title: "HR All", applicationId: app.id, width: 6, height: 2, x: 6, y: 1 },
  { type: "TIMESERIES_GRAPH", title: "App RT Graph", applicationId: app.id,
    metricPath: "Overall Application Performance|Average Response Time (ms)", width: 6, height: 3, x: 0, y: 3 },
  { type: "METRIC_VALUE", title: "App CPM", applicationId: app.id,
    metricPath: "Overall Application Performance|Calls per Minute", width: 3, height: 2, x: 6, y: 3 },
  { type: "METRIC_VALUE", title: "BT ART", applicationId: app.id,
    metricPath: "Business Transaction Performance|Average Response Time (ms)", width: 3, height: 2, x: 9, y: 3 },
];
const createText = await call("appd_create_dashboard", { name: DASH_NAME, widgets });
console.log(`\n${createText}`);
const dashId = parseInt((createText.match(/ID: (\d+)/) ?? [])[1], 10);
check("create returned a dashboard id", !isNaN(dashId), createText);

// ── 3. Assert persisted RESTUI shapes ────────────────────────────────────────
const ui = await rawReq("GET", `${BASE}/controller/restui/dashboards/dashboardIfUpdated/${dashId}/-1`, null, AUTH);
const dw = ui.body.widgets ?? [];
console.log(`\nPersisted widgets: ${dw.map(w => `${w.type}:"${w.title}"`).join(", ")}`);

const header = dw.find(w => w.title === "Header");
check("TEXT widget persisted as LABEL", header?.type === "LABEL", JSON.stringify(header?.type));

if (simRuleIds.length) {
  const hrScoped = dw.find(w => w.title === "HR Scoped");
  check("scoped HEALTH_LIST → SPECIFIED", hrScoped?.entitySelectionType === "SPECIFIED", JSON.stringify(hrScoped?.entitySelectionType));
  check("scoped HEALTH_LIST → entityIds", JSON.stringify(hrScoped?.entityIds) === JSON.stringify(simRuleIds), JSON.stringify(hrScoped?.entityIds));
  check("scoped HEALTH_LIST → POLICY", hrScoped?.entityType === "POLICY", JSON.stringify(hrScoped?.entityType));
  check("scoped HEALTH_LIST → applicationId", hrScoped?.applicationId === 322, JSON.stringify(hrScoped?.applicationId));
}

const hrAll = dw.find(w => w.title === "HR All");
check("unscoped HEALTH_LIST → ALL", hrAll?.entitySelectionType === "ALL", JSON.stringify(hrAll?.entitySelectionType));
check("unscoped HEALTH_LIST → POLICY", hrAll?.entityType === "POLICY", JSON.stringify(hrAll?.entityType));

const rt = dw.find(w => w.title === "App RT Graph");
const rtCrit = rt?.widgetsMetricMatchCriterias?.[0];
check("app-level graph has criteria", !!rtCrit, JSON.stringify(rt?.widgetsMetricMatchCriterias));
if (rtCrit) {
  // Verified live via POST /restui/dashboards/widgetData: app-scope metrics
  // return the true app aggregate ONLY with OVERALL_AFFECTED_EMC/APPLICATION.
  check("app-level graph uses OVERALL_AFFECTED_EMC with Root||OAP||rest path",
    rtCrit.metricMatchCriteria?.affectedEntityMatchCriteria?.aemcType === "OVERALL_AFFECTED_EMC" &&
    rtCrit.metricMatchCriteria?.affectedEntityMatchCriteria?.type === "APPLICATION" &&
    rtCrit.metricMatchCriteria?.metricExpression?.inputMetricPath === "Root||Overall Application Performance||Average Response Time (ms)",
    JSON.stringify(rtCrit.metricMatchCriteria));
  check("graph rollup=false", rtCrit.metricMatchCriteria?.rollupMetricData === false, "");
  // NOTE: actual rendering (POST /restui/dashboards/widgetData) can only be
  // exercised from a browser session — the endpoint 500s under OAuth tokens.
  // Rendering was verified visually in the AppDynamics UI (see CLAUDE.md).
}

const cpm = dw.find(w => w.title === "App CPM");
const cpmCrit = cpm?.widgetsMetricMatchCriterias?.[0];
check("METRIC_VALUE persisted as METRIC_LABEL", cpm?.type === "METRIC_LABEL", JSON.stringify(cpm?.type));
check("value widget rollup=true", cpmCrit?.metricMatchCriteria?.rollupMetricData === true, JSON.stringify(cpmCrit?.metricMatchCriteria?.rollupMetricData));

// BT path WITHOUT btIds routes to the OVERALL app-aggregate shape
// (BT_AFFECTED_EMC/ALL renders '--' on labels — verified in the UI).
const bt = dw.find(w => w.title === "BT ART");
const btCrit = bt?.widgetsMetricMatchCriterias?.[0];
check("BT metric without btIds uses OVERALL shape", btCrit?.metricMatchCriteria?.affectedEntityMatchCriteria?.aemcType === "OVERALL_AFFECTED_EMC",
  JSON.stringify(btCrit?.metricMatchCriteria?.affectedEntityMatchCriteria?.aemcType));

// ── 4. Verify the metric paths actually have data ────────────────────────────
for (const mp of ["Overall Application Performance|Average Response Time (ms)", "Overall Application Performance|Calls per Minute"]) {
  const md = await rawReq("GET",
    `${BASE}/controller/rest/applications/${app.id}/metric-data?metric-path=${encodeURIComponent(mp)}&time-range-type=BEFORE_NOW&duration-in-mins=60&rollup=true&output=JSON`,
    null, AUTH);
  const vals = Array.isArray(md.body) ? (md.body[0]?.metricValues ?? []) : [];
  check(`metric data exists: ${mp}`, vals.length > 0, JSON.stringify(md.body).slice(0, 150));
}

// ── 5. Auto-build dashboard ───────────────────────────────────────────────────
const autoText = await call("appd_auto_build_dashboard", { applicationName: String(app.id), dashboardName: `MCP AutoBuild Verification ${Date.now()}` });
console.log(`\n${autoText}`);
const autoId = parseInt((autoText.match(/ID: (\d+)/) ?? [])[1], 10);
check("auto-build returned id", !isNaN(autoId), autoText);
if (!isNaN(autoId)) {
  const aui = await rawReq("GET", `${BASE}/controller/restui/dashboards/dashboardIfUpdated/${autoId}/-1`, null, AUTH);
  const aw = aui.body.widgets ?? [];
  const health = aw.filter(w => w.type === "HEALTH_LIST");
  const graphs = aw.filter(w => w.type === "TIMESERIES_GRAPH");
  console.log(`auto-build widgets: ${aw.length} (health: ${health.length}, graphs: ${graphs.length})`);
  check("auto-build health widgets exist", health.length > 0, "");
  check("auto-build health widgets are POLICY", health.every(h => h.entityType === "POLICY"),
    JSON.stringify(health.map(h => h.entityType)));
  check("auto-build health widgets scoped or ALL", health.every(h => h.entitySelectionType === "SPECIFIED" || h.entitySelectionType === "ALL"),
    JSON.stringify(health.map(h => h.entitySelectionType)));
  const graphCrits = graphs.map(g => g.widgetsMetricMatchCriterias?.[0]).filter(Boolean);
  check("auto-build graphs have criteria", graphCrits.length === graphs.length, `${graphCrits.length}/${graphs.length}`);
  check("auto-build graph paths use Root||category||rest form", graphCrits.every(c =>
    String(c.metricMatchCriteria?.metricExpression?.inputMetricPath ?? "").startsWith("Root||")),
    JSON.stringify(graphCrits.map(c => c.metricMatchCriteria?.metricExpression?.inputMetricPath)));
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECKS FAILED"}`);
console.log(`Dashboards for visual review: ${dashId}, ${autoId}`);
console.log(`URL: ${BASE}/controller/#/location=CDASHBOARD_DETAIL&mode=MODE_DASHBOARD&dashboardId=${dashId}`);
await client.close();
process.exit(failures === 0 ? 0 : 1);
