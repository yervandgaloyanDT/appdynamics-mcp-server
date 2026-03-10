/**
 * Fix dashboard 8542: set entitySelectionType="SPECIFIED" + entityIds=[ruleId].
 * The working format (from dashboards 6514/6471) is:
 *   entitySelectionType: "SPECIFIED"  (NOT null, NOT "ALL", NOT "SPECIFIC")
 *   entityIds: [ruleId]
 *   entityType: "POLICY"
 *   properties: []  (no selectedEntityIds property needed)
 */
import https from "https";
const BASE    = "https://experience.saas.appdynamics.com";

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
    "grant_type=client_credentials&client_id=mcpV2%40experience&client_secret=REDACTED-ROTATED-SECRET",
    { "Content-Type": "application/x-www-form-urlencoded" });
  _tok = r.body.access_token; return _tok;
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

async function fixDashboard(dashId) {
  console.log(`Fetching dashboard ${dashId}...`);
  const dashR = await appdGet(`/controller/restui/dashboards/dashboardIfUpdated/${dashId}/-1`);
  if (dashR.status !== 200) { console.error("Fetch failed:", dashR.status); return; }

  const dash = dashR.body;
  let patched = 0;
  const updatedWidgets = (dash.widgets ?? []).map(w => {
    if (w.type !== "HEALTH_LIST") return w;
    // Get rule ID from properties or entityIds
    const prop = (w.properties ?? []).find(p => p.name === "selectedEntityIds");
    const ruleId = prop
      ? parseInt(prop.value, 10)
      : (Array.isArray(w.entityIds) && w.entityIds.length > 0 ? w.entityIds[0] : null);
    if (!ruleId) return w;
    patched++;
    console.log(`  Patching "${w.title}": entitySelectionType null→SPECIFIED, entityIds=${JSON.stringify([ruleId])}`);
    return {
      ...w,
      entitySelectionType: "SPECIFIED",
      entityIds: [ruleId],
      properties: [],  // Remove selectedEntityIds property — working dashboards don't have it
    };
  });

  if (patched === 0) { console.log("No HEALTH_LIST widgets to patch"); return; }

  console.log(`\nPushing update for ${patched} widgets...`);
  const updR = await appdPost(`/controller/restui/dashboards/updateDashboard`,
    { ...dash, widgets: updatedWidgets });
  console.log(`Update: HTTP ${updR.status}`);
  if (updR.status !== 200) {
    console.error("Failed:", JSON.stringify(updR.body).slice(0, 200));
    return;
  }

  // Verify
  const verR = await appdGet(`/controller/restui/dashboards/dashboardIfUpdated/${dashId}/-1`);
  console.log("\nVerification:");
  for (const w of (verR.body?.widgets ?? [])) {
    if (w.type !== "HEALTH_LIST") continue;
    console.log(`  "${w.title}": entitySelectionType=${w.entitySelectionType} entityIds=${JSON.stringify(w.entityIds)}`);
  }
  console.log(`\n✓ Done — https://experience.saas.appdynamics.com/controller/#/location=DASHBOARD_DETAIL&timeRange=last_15_minutes.BEFORE_NOW.-1.-1.60&dashboardId=${dashId}`);
}

await fixDashboard(8542);
console.log("\n--- Also fix 8541 ---");
await fixDashboard(8541);
