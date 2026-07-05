/**
 * Check applicationId in HealthListWidgets across working dashboards (6514, 6471)
 * vs our dashboards (8542, 8541).
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

for (const dashId of [6514, 6471, 8542, 8541]) {
  const r = await rawReq("GET", `${BASE}/controller/restui/dashboards/dashboardIfUpdated/${dashId}/-1`, null, H);
  if (r.status !== 200) { console.log(`${dashId}: HTTP ${r.status}`); continue; }
  const hw = (r.body?.widgets ?? []).filter(w => w.type === "HEALTH_LIST");
  console.log(`\nDashboard ${dashId} "${r.body?.name}" — ${hw.length} HealthList widgets`);
  for (const w of hw.slice(0, 3)) {
    console.log(`  "${w.title}": applicationId=${w.applicationId} entityIds=${JSON.stringify(w.entityIds)} entitySelectionType=${w.entitySelectionType}`);
  }
}

// Also check which app name corresponds to applicationId in our dashboards
const appsR = await rawReq("GET", `${BASE}/controller/rest/applications?output=JSON`, null, H);
const apps = Array.isArray(appsR.body) ? appsR.body : [];
console.log(`\nApplications list has ${apps.length} entries`);
const app322 = apps.find(a => a.id === 322);
console.log(`App ID 322: ${app322 ? `"${app322.name}"` : "NOT FOUND in standard list"}`);
// Show first 5
for (const a of apps.slice(0, 5)) {
  console.log(`  id=${a.id} name="${a.name}"`);
}
