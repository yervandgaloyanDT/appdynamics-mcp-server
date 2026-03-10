/**
 * Get RESTUI representation of dashboard 8542 and show HealthListWidget properties.
 */
import https from "https";
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

const tokR = await rawReq("POST", `${BASE}/controller/api/oauth/access_token`,
  "grant_type=client_credentials&client_id=mcpV2%40experience&client_secret=REDACTED-ROTATED-SECRET",
  { "Content-Type": "application/x-www-form-urlencoded" });
const tok = tokR.body.access_token;
const H = { "Authorization": `Bearer ${tok}`, "Accept": "application/json" };

const r = await rawReq("GET",
  `${BASE}/controller/restui/dashboards/dashboardIfUpdated/${DASH_ID}/-1`,
  null, H);

console.log(`Status: ${r.status}`);
if (r.status !== 200) {
  console.log("Body:", JSON.stringify(r.body).slice(0, 300));
  process.exit(1);
}

const dash = r.body;
const widgets = dash.widgets ?? [];
console.log(`Name: "${dash.name}", widgets: ${widgets.length}`);

// Show all widgets
for (let i = 0; i < widgets.length; i++) {
  const w = widgets[i];
  console.log(`\n[${i}] type=${w.type} id=${w.id} guid=${w.guid} title="${w.title}"`);
  console.log(`  entitySelectionType=${w.entitySelectionType}`);
  console.log(`  properties=${JSON.stringify(w.properties)}`);
  console.log(`  entityReferences=${JSON.stringify(w.entityReferences)}`);
}

// Full first widget
if (widgets.length > 0) {
  console.log("\n=== Full first widget (RESTUI format) ===");
  console.log(JSON.stringify(widgets[0], null, 2));
}
