/**
 * Probe whether AppD RESTUI has a separate "policy entity" ID system
 * different from the alerting API health-rule IDs.
 * Also try entitySelectionType="SPECIFIC" via RESTUI updateDashboard.
 */
import https from "https";
import { tokenFormBody } from "./_appd-env.mjs";
const BASE    = "https://experience.saas.appdynamics.com";
const APP_ID  = 322;
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
const tokR = await rawReq("POST", `${BASE}/controller/api/oauth/access_token`,
  tokenFormBody(),
  { "Content-Type": "application/x-www-form-urlencoded" });
const tok = tokR.body.access_token;
const H = { "Authorization": `Bearer ${tok}`, "Accept": "application/json" };
const HJ = { ...H, "Content-Type": "application/json" };

// ── 1. Check various RESTUI "policy" / health rule list endpoints ──────────────
const probeEndpoints = [
  `/controller/restui/policy/list/${APP_ID}`,
  `/controller/restui/healthrules/list/${APP_ID}`,
  `/controller/restui/policies/${APP_ID}`,
  `/controller/restui/alerting/policies/${APP_ID}`,
  `/controller/restui/policyManagement/getHealthRules?applicationId=${APP_ID}`,
  `/controller/restui/policyManagement/getPolicies/${APP_ID}`,
];

for (const ep of probeEndpoints) {
  const r = await rawReq("GET", `${BASE}${ep}`, null, H);
  if (r.status === 200) {
    const items = Array.isArray(r.body) ? r.body : (r.body?.data ?? r.body?.items ?? []);
    console.log(`[200] ${ep} → ${Array.isArray(items) ? items.length + " items" : JSON.stringify(r.body).slice(0, 100)}`);
    if (Array.isArray(items) && items.length > 0) {
      console.log("  First item:", JSON.stringify(items[0]).slice(0, 200));
    }
  } else {
    console.log(`[${r.status}] ${ep}`);
  }
}

// ── 2. Try entitySelectionType="SPECIFIC" via RESTUI updateDashboard ──────────
console.log("\n=== Try entitySelectionType=SPECIFIC on first widget ===");
const dashR = await rawReq("GET", `${BASE}/controller/restui/dashboards/dashboardIfUpdated/${DASH_ID}/-1`, null, H);
const dash = dashR.body;
const widgets = dash.widgets ?? [];

// Make a copy with only the first widget changed
const testDash = {
  ...dash,
  widgets: widgets.map((w, i) => {
    if (i !== 0) return w;
    return { ...w, entitySelectionType: "SPECIFIC", entityIds: [291028] };
  }),
};

const updR = await rawReq("POST", `${BASE}/controller/restui/dashboards/updateDashboard`,
  testDash, HJ);
console.log(`Update with SPECIFIC: HTTP ${updR.status}`);
if (updR.status !== 200) {
  console.log("Error:", JSON.stringify(updR.body).slice(0, 200));
} else {
  // Re-fetch and check
  const recheckR = await rawReq("GET", `${BASE}/controller/restui/dashboards/dashboardIfUpdated/${DASH_ID}/-1`, null, H);
  const w0 = recheckR.body?.widgets?.[0];
  console.log(`First widget after update: entitySelectionType=${w0?.entitySelectionType} entityIds=${JSON.stringify(w0?.entityIds)}`);
}
