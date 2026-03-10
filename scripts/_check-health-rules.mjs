import https from "https";
const BASE    = "https://experience.saas.appdynamics.com";
const APP_NAME = "Server & Infrastructure Monitoring";

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

// Get app ID
const appR = await rawReq("GET", `${BASE}/controller/rest/applications/${encodeURIComponent(APP_NAME)}?output=JSON`, null, H);
const appId = appR.body?.[0]?.id;
console.log(`App: "${APP_NAME}" → ID ${appId}`);

// Get all health rules
const rulesR = await rawReq("GET", `${BASE}/controller/alerting/rest/v1/applications/${appId}/health-rules`, null, H);
const allRules = Array.isArray(rulesR.body) ? rulesR.body : [];
const urlRules = allRules.filter(r => r.name?.startsWith("URL: ZOOKEEPER"));
urlRules.sort((a, b) => a.id - b.id);

console.log(`\nZOOKEEPER health rules (${urlRules.length}):`);
for (const r of urlRules) {
  console.log(`  ID=${r.id}  enabled=${r.enabled}  name="${r.name}"`);
}

// Check expected IDs
const expected = [291028, 291029, 291030, 291031, 291032, 291033];
const foundIds = new Set(urlRules.map(r => r.id));
console.log("\nExpected IDs (291028-291033) present:");
for (const id of expected) {
  console.log(`  ${id}: ${foundIds.has(id) ? "YES" : "MISSING"}`);
}
