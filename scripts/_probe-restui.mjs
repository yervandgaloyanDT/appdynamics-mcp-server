/**
 * Try various RESTUI endpoints to get dashboard 8542, and also check 8541 (URL Monitor Service Health)
 * which may have working HealthListWidgets.
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

// Try various RESTUI get-dashboard endpoints for ID 8542
const endpoints = [
  `/controller/restui/dashboards/getDashboardById?dashboardId=8542`,
  `/controller/restui/dashboards/8542`,
  `/controller/restui/dashboards/getCustomDashboard?dashboardId=8542`,
  `/controller/restui/dashboards/getDashboard?dashboardId=8542`,
  `/controller/restui/dashboards/getCustomDashboardById/8542`,
];

for (const ep of endpoints) {
  const r = await rawReq("GET", `${BASE}${ep}`, null, H);
  const snippet = typeof r.body === "object"
    ? (r.body?.name ?? r.body?.displayText ?? JSON.stringify(r.body).slice(0, 80))
    : String(r.body).slice(0, 80);
  console.log(`[${r.status}] GET ${ep}`);
  if (r.status === 200) {
    console.log(`  → name="${r.body?.name}", widgets=${r.body?.widgets?.length}`);
    // Show first HealthListWidget's properties
    const widgets = r.body?.widgets ?? [];
    const hw = widgets.find(w => w.type === "HEALTH_LIST" || w.widgetType === "HealthListWidget" || w.type?.includes("HEALTH"));
    if (hw) {
      console.log(`  First health widget: ${JSON.stringify(hw, null, 2).slice(0, 500)}`);
    }
  } else {
    console.log(`  → ${snippet}`);
  }
}
