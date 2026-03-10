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

const r = await rawReq("GET", `${BASE}/controller/restui/dashboards/getAllDashboardsByType/false`, null, H);
const dashes = Array.isArray(r.body) ? r.body : [];
dashes.sort((a, b) => b.id - a.id);
console.log(`Total dashboards: ${dashes.length}`);
for (const d of dashes.slice(0, 20)) {
  console.log(`  ID=${d.id}  name="${d.name}"`);
}
