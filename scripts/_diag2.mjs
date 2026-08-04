/**
 * Check current RESTUI state of dashboard 8542 + export 8527 for comparison.
 */
import https from "https";
import { tokenFormBody } from "./_appd-env.mjs";
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
  tokenFormBody(),
  { "Content-Type": "application/x-www-form-urlencoded" });
const tok = tokR.body.access_token;
const H = { "Authorization": `Bearer ${tok}`, "Accept": "application/json" };

// ── 8542 current RESTUI state ──────────────────────────────────────────────────
console.log("=== 8542 RESTUI state ===");
const r42 = await rawReq("GET", `${BASE}/controller/restui/dashboards/dashboardIfUpdated/8542/-1`, null, H);
for (const w of (r42.body?.widgets ?? [])) {
  console.log(`  "${w.title}"`);
  console.log(`    entityType=${w.entityType} entitySelectionType=${w.entitySelectionType}`);
  console.log(`    entityIds=${JSON.stringify(w.entityIds)}`);
  console.log(`    properties=${JSON.stringify(w.properties)}`);
}

// ── 8527 export format ─────────────────────────────────────────────────────────
console.log("\n=== 8527 export format (URL Monitor - ip-10-0-1-163) ===");
const exp27 = await rawReq("GET", `${BASE}/controller/CustomDashboardImportExportServlet?dashboardId=8527`, null, H);
const w27 = (exp27.body?.widgetTemplates ?? []).filter(w => w.widgetType === "HealthListWidget");
console.log(`HealthListWidgets: ${w27.length}`);
for (let i = 0; i < Math.min(w27.length, 3); i++) {
  console.log(`\n  [${i}] "${w27[i].title}"`);
  console.log(JSON.stringify(w27[i], null, 2));
}

// ── 8541 RESTUI state ─────────────────────────────────────────────────────────
console.log("\n=== 8541 RESTUI state (URL Monitor Service Health) ===");
const r41 = await rawReq("GET", `${BASE}/controller/restui/dashboards/dashboardIfUpdated/8541/-1`, null, H);
const hw41 = (r41.body?.widgets ?? []).filter(w => w.type === "HEALTH_LIST");
console.log(`HealthList widgets: ${hw41.length}`);
for (let i = 0; i < Math.min(hw41.length, 3); i++) {
  const w = hw41[i];
  console.log(`  "${w.title}": entitySelectionType=${w.entitySelectionType} entityIds=${JSON.stringify(w.entityIds)} properties=${JSON.stringify(w.properties)}`);
}
