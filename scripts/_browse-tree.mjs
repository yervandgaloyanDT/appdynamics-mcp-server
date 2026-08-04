import https from "https";
import { tokenFormBody } from "./_appd-env.mjs";

const BASE = "https://experience.saas.appdynamics.com";
const SIM  = "Server & Infrastructure Monitoring";
const NODE = "ip-10-0-1-163.eu-west-1.compute.internal";
const ROOT = `Application Infrastructure Performance|Root|Individual Nodes|${NODE}|Custom Metrics|URL Monitor`;

function req(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + path);
    const b = body ? Buffer.from(typeof body === "string" ? body : JSON.stringify(body)) : null;
    const r = https.request({ hostname: u.hostname, port: 443, path: u.pathname + u.search, method,
      headers: { ...headers, ...(b ? { "Content-Length": b.length } : {}) }
    }, rr => {
      const cs = []; rr.on("data", c => cs.push(c));
      rr.on("end", () => {
        const d = Buffer.concat(cs).toString();
        try { resolve({ status: rr.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: rr.statusCode, body: d }); }
      });
    });
    r.on("error", reject); if (b) r.write(b); r.end();
  });
}

const tokR = await req("POST", "/controller/api/oauth/access_token",
  tokenFormBody(),
  { "Content-Type": "application/x-www-form-urlencoded" });
const tok = tokR.body.access_token;
const H = { "Authorization": "Bearer " + tok, "Accept": "application/json" };

async function browse(path, depth = 0) {
  const r = await req("GET",
    "/controller/rest/applications/" + encodeURIComponent(SIM) +
    "/metrics?metric-path=" + encodeURIComponent(path) + "&output=JSON", null, H);
  if (r.status !== 200 || !Array.isArray(r.body)) {
    console.log("  ".repeat(depth) + "[err " + r.status + "] " + JSON.stringify(r.body).slice(0, 200));
    return [];
  }
  const results = [];
  for (const item of r.body) {
    console.log("  ".repeat(depth) + (item.type === "folder" ? "📁" : "📊") + " " + item.name);
    if (item.type === "folder" && depth < 5) {
      const children = await browse(path + "|" + item.name, depth + 1);
      results.push(...children);
    } else if (item.type !== "folder") {
      results.push({ path: path + "|" + item.name, name: item.name });
    }
  }
  return results;
}

console.log("=== URL Monitor tree ===");
console.log("Root: " + ROOT + "\n");
const leaves = await browse(ROOT);
console.log("\nTotal leaf metrics: " + leaves.length);
