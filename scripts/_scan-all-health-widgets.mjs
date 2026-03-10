/**
 * Scan ALL dashboards via RESTUI for HealthListWidgets.
 * Looking for any that have non-empty entityIds or unusual configuration.
 */
import https from "https";
const BASE = "https://experience.saas.appdynamics.com";

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
  "grant_type=client_credentials&client_id=mcpV2%40experience&client_secret=REDACTED-ROTATED-SECRET",
  { "Content-Type": "application/x-www-form-urlencoded" });
const tok = tokR.body.access_token;
const H = { "Authorization": `Bearer ${tok}`, "Accept": "application/json" };

// Get all dashboards
const listR = await rawReq("GET", `${BASE}/controller/restui/dashboards/getAllDashboardsByType/false`, null, H);
const dashes = Array.isArray(listR.body) ? listR.body : [];
console.log(`Total dashboards: ${dashes.length}`);

let totalHW = 0;
for (const d of dashes) {
  const r = await rawReq("GET", `${BASE}/controller/restui/dashboards/dashboardIfUpdated/${d.id}/-1`, null, H);
  if (r.status !== 200) continue;
  const widgets = (r.body?.widgets ?? []).filter(w => w.type === "HEALTH_LIST");
  if (widgets.length === 0) continue;
  totalHW += widgets.length;
  console.log(`\nDashboard ${d.id} "${d.name}" — ${widgets.length} HealthListWidgets`);
  for (const w of widgets) {
    const hasNonEmptyIds = Array.isArray(w.entityIds) && w.entityIds.length > 0;
    const hasPropIds     = (w.properties ?? []).some(p => p.name === "selectedEntityIds");
    const flags = [
      hasNonEmptyIds ? `entityIds=${JSON.stringify(w.entityIds)}` : "entityIds=[]",
      `entitySelectionType=${w.entitySelectionType}`,
      `entityType=${w.entityType}`,
      hasPropIds ? `prop.selectedEntityIds=${(w.properties.find(p=>p.name==="selectedEntityIds"))?.value}` : "no-prop",
    ];
    console.log(`  "${w.title}": ${flags.join(" | ")}`);
  }
}
console.log(`\nTotal HealthListWidgets across all dashboards: ${totalHW}`);
