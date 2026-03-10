/**
 * Export dashboard 8535 and show first few HealthListWidget fields in full.
 * This is the dashboard with a manually-configured working widget.
 */
import https from "https";
const BASE    = "https://experience.saas.appdynamics.com";
const DASH_ID = 8535;

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

const expR = await rawReq("GET", `${BASE}/controller/CustomDashboardImportExportServlet?dashboardId=${DASH_ID}`,
  null, { "Authorization": `Bearer ${tok}`, "Accept": "application/json" });

console.log(`Export status: ${expR.status}`);
const exp = expR.body;
const widgets = exp.widgetTemplates ?? [];
console.log(`Dashboard: "${exp.name}", widgets: ${widgets.length}`);

const healthWidgets = widgets.filter(w => w.widgetType === "HealthListWidget");
console.log(`HealthListWidgets: ${healthWidgets.length}`);

for (let i = 0; i < Math.min(healthWidgets.length, 5); i++) {
  console.log(`\n--- HealthListWidget [${i}] "${healthWidgets[i].title}" ---`);
  console.log(JSON.stringify(healthWidgets[i], null, 2));
}

if (healthWidgets.length === 0) {
  console.log("\nAll widgets:");
  for (let i = 0; i < Math.min(widgets.length, 3); i++) {
    console.log(`\n--- Widget [${i}] type="${widgets[i].widgetType}" title="${widgets[i].title}" ---`);
    console.log(JSON.stringify(widgets[i], null, 2));
  }
}
