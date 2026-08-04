/**
 * Fix dashboard 8542: set entityIds=[ruleId] on each HealthListWidget.
 * The import servlet set properties.selectedEntityIds but left entityIds=[].
 * AppD UI uses entityIds for actual filtering.
 */
import https from "https";
import { tokenFormBody } from "./_appd-env.mjs";
const BASE    = "https://experience.saas.appdynamics.com";
const DASH_ID = 8542;

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

let _tok = null;
async function getToken() {
  if (_tok) return _tok;
  const r = await rawReq("POST", `${BASE}/controller/api/oauth/access_token`,
    tokenFormBody(),
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

// 1. Get current RESTUI dashboard
console.log(`Fetching dashboard ${DASH_ID}...`);
const dashR = await appdGet(`/controller/restui/dashboards/dashboardIfUpdated/${DASH_ID}/-1`);
if (dashR.status !== 200) {
  console.error("Failed:", dashR.status, JSON.stringify(dashR.body).slice(0,200));
  process.exit(1);
}

const dash = dashR.body;
console.log(`Got "${dash.name}" with ${dash.widgets?.length} widgets`);

// 2. For each HealthListWidget, extract ruleId from properties and set entityIds
let patched = 0;
for (const w of (dash.widgets ?? [])) {
  if (w.type !== "HEALTH_LIST") continue;

  const prop = (w.properties ?? []).find(p => p.name === "selectedEntityIds");
  const ruleId = prop ? parseInt(prop.value, 10) : null;

  if (!ruleId) {
    console.log(`  Widget "${w.title}": no selectedEntityIds, skipping`);
    continue;
  }

  const wasEmpty = !w.entityIds || w.entityIds.length === 0;
  w.entityIds = [ruleId];
  console.log(`  Widget "${w.title}": entityIds [] → [${ruleId}]${wasEmpty ? "" : " (was non-empty)"}`);
  patched++;
}

console.log(`\nPatched ${patched} widgets`);

if (patched === 0) {
  console.log("Nothing to fix");
  process.exit(0);
}

// 3. Push updated dashboard via RESTUI updateDashboard
console.log("\nUpdating dashboard via RESTUI...");
const updR = await appdPost(`/controller/restui/dashboards/updateDashboard`, dash);
console.log(`Update status: ${updR.status}`);
if (updR.status !== 200) {
  console.error("Update failed:", JSON.stringify(updR.body).slice(0, 300));
  process.exit(1);
}

// 4. Verify
console.log("\nVerifying...");
const verR = await appdGet(`/controller/restui/dashboards/dashboardIfUpdated/${DASH_ID}/-1`);
const verWidgets = verR.body?.widgets ?? [];
let ok = true;
for (const w of verWidgets) {
  if (w.type !== "HEALTH_LIST") continue;
  const prop = (w.properties ?? []).find(p => p.name === "selectedEntityIds");
  const ruleId = prop ? parseInt(prop.value, 10) : null;
  const hasId = (w.entityIds ?? []).includes(ruleId);
  console.log(`  "${w.title}": entityIds=${JSON.stringify(w.entityIds)} → ${hasId ? "OK" : "STILL EMPTY"}`);
  if (!hasId) ok = false;
}

console.log(ok ? "\n✓ All widgets patched successfully" : "\n✗ Some widgets still have empty entityIds");
console.log(`🔗 ${BASE}/controller/#/location=DASHBOARD_DETAIL&timeRange=last_15_minutes.BEFORE_NOW.-1.-1.60&dashboardId=${DASH_ID}`);
