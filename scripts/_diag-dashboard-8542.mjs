/**
 * Diagnose dashboard 8542 — check what propertiesMap / entitySelectionType
 * was actually stored by the import servlet.
 */
import https from "https";
import { tokenFormBody } from "./_appd-env.mjs";

const BASE    = "https://experience.saas.appdynamics.com";
const DASH_ID = 8542;

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
    tokenFormBody(),
    { "Content-Type": "application/x-www-form-urlencoded" });
  _tok = r.body.access_token;
  return _tok;
}
async function appdGet(path) {
  const t = await getToken();
  return rawReq("GET", `${BASE}${path}`, null, { "Authorization": `Bearer ${t}`, "Accept": "application/json" });
}

// ── 1. Export via servlet ─────────────────────────────────────────────────────
console.log(`=== Export servlet for dashboard ${DASH_ID} ===`);
const t = await getToken();
const expR = await rawReq("GET", `${BASE}/controller/CustomDashboardImportExportServlet?dashboardId=${DASH_ID}`,
  null, { "Authorization": `Bearer ${t}`, "Accept": "application/json" });

console.log(`Export status: ${expR.status}`);
if (expR.status !== 200) {
  console.error("Export body:", JSON.stringify(expR.body).slice(0, 300));
  process.exit(1);
}

const exp = expR.body;
const expWidgets = exp.widgetTemplates ?? [];
console.log(`Format: ${exp.dashboardFormatVersion}, widgets: ${expWidgets.length}`);

console.log("\n--- Export widgets (propertiesMap + entitySelectionType) ---");
for (let i = 0; i < expWidgets.length; i++) {
  const w = expWidgets[i];
  console.log(`[${i}] title="${w.title}"`);
  console.log(`     entityType=${w.entityType} entitySelectionType=${w.entitySelectionType}`);
  console.log(`     propertiesMap=${JSON.stringify(w.propertiesMap)}`);
}

// ── 2. Full first widget ──────────────────────────────────────────────────────
if (expWidgets.length > 0) {
  console.log("\n--- Full first export widget ---");
  console.log(JSON.stringify(expWidgets[0], null, 2));
}

// ── 3. RESTUI fetch ───────────────────────────────────────────────────────────
console.log(`\n=== RESTUI getDashboard ===`);
const ruiR = await appdGet(`/controller/restui/dashboards/getDashboardById?dashboardId=${DASH_ID}`);
console.log(`RESTUI status: ${ruiR.status}`);
if (ruiR.status === 200) {
  const rui = ruiR.body;
  const ruiWidgets = rui.widgets ?? [];
  console.log(`Name: ${rui.name}, widgets: ${ruiWidgets.length}`);
  for (let i = 0; i < Math.min(ruiWidgets.length, 6); i++) {
    const w = ruiWidgets[i];
    console.log(`[${i}] title="${w.title}" entitySelectionType=${w.entitySelectionType}`);
    console.log(`     properties=${JSON.stringify(w.properties)}`);
  }
} else {
  console.log("RESTUI body:", JSON.stringify(ruiR.body).slice(0, 200));
}
