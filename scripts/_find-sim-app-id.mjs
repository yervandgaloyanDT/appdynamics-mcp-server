import https from "https";
const BASE = "https://experience.saas.appdynamics.com";
const NODE = "ip-10-0-1-163.eu-west-1.compute.internal";
const FULL_STATUS = `Application Infrastructure Performance|Root|Individual Nodes|${NODE}|Custom Metrics|URL Monitor|ACTIVEMQ_b2X|ACTIVEMQ_b2X_1_mglx264p|Status`;

function req(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + path);
    const b = body ? Buffer.from(typeof body === "string" ? body : JSON.stringify(body)) : null;
    const r = https.request({ hostname: u.hostname, port: 443, path: u.pathname + u.search, method,
      headers: { ...headers, ...(b ? { "Content-Length": b.length } : {}) }
    }, rr => {
      const cs = []; rr.on("data", c => cs.push(c));
      rr.on("end", () => { const d = Buffer.concat(cs).toString();
        try { resolve({ status: rr.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: rr.statusCode, body: d }); }
      });
    });
    r.on("error", reject); if (b) r.write(b); r.end();
  });
}
const tokR = await req("POST", "/controller/api/oauth/access_token",
  "grant_type=client_credentials&client_id=mcpV2%40experience&client_secret=REDACTED-ROTATED-SECRET",
  { "Content-Type": "application/x-www-form-urlencoded" });
const tok = tokR.body.access_token;
const H = { "Authorization": "Bearer " + tok, "Accept": "application/json", "Content-Type": "application/json" };

const baseCriteria = {
  conditionAggregationType: "ALL",
  conditionExpression: null,
  conditions: [{
    name: "Status != 4", shortName: "A",
    evaluateToTrueOnNoData: false, violationStatusOnNoData: "UNKNOWN",
    wildcardMetricMatchType: "DEFAULT_ALL_METRIC_PATH",
    evalDetail: {
      evalDetailType: "SINGLE_METRIC", metricAggregateFunction: "VALUE",
      metricPath: FULL_STATUS,
      metricEvalDetail: { metricEvalDetailType: "SPECIFIC_TYPE", compareCondition: "NOT_EQUALS", compareValue: 4 },
      inputMetricText: false,
    },
    triggerEnabled: false, minimumTriggers: 1,
  }],
  evalMatchingCriteria: { matchType: "ANY", value: null },
};

async function tryAffects(label, affects) {
  const payload = {
    name: `_test_${Date.now()}`,
    enabled: false, useDataFromLastNMinutes: 5, waitTimeAfterViolation: 5,
    splitEventsByMetrics: false, scheduleName: "Always",
    affects,
    evalCriterias: { criticalCriteria: baseCriteria, warningCriteria: null },
  };
  const r = await req("POST", "/controller/alerting/rest/v1/applications/322/health-rules", payload, H);
  const ok = r.status === 200 || r.status === 201;
  const msg = ok ? `ID=${r.body?.id}` : JSON.stringify(r.body?.message ?? r.body).slice(0, 150);
  console.log(`${ok ? "✓" : "✗"} [${r.status}] ${label}: ${msg}`);
  if (ok && r.body?.id) await req("DELETE", `/controller/alerting/rest/v1/applications/322/health-rules/${r.body.id}`, null, H);
  return ok;
}

// Try various CUSTOM entityScope / entityType combinations
await tryAffects("CUSTOM ALL_ENTITIES",
  { affectedEntityType: "CUSTOM", affectedEntityScope: { entityScope: "ALL_ENTITIES", entityType: "MACHINE_INSTANCE", affectedEntityName: NODE } });

await tryAffects("CUSTOM SPECIFIC + entityType=MACHINE_INSTANCE",
  { affectedEntityType: "CUSTOM", affectedEntityScope: { entityScope: "SPECIFIC_ENTITY_PERFORMANCE", entityType: "MACHINE_INSTANCE", affectedEntityName: NODE } });

await tryAffects("CUSTOM SPECIFIC + entityType=SERVER",
  { affectedEntityType: "CUSTOM", affectedEntityScope: { entityScope: "SPECIFIC_ENTITY_PERFORMANCE", entityType: "SERVER", affectedEntityName: NODE } });

await tryAffects("CUSTOM SPECIFIC + entityType=APPLICATION_COMPONENT_NODE",
  { affectedEntityType: "CUSTOM", affectedEntityScope: { entityScope: "SPECIFIC_ENTITY_PERFORMANCE", entityType: "APPLICATION_COMPONENT_NODE", affectedEntityName: NODE } });

await tryAffects("CUSTOM SPECIFIC + entityType=NODE",
  { affectedEntityType: "CUSTOM", affectedEntityScope: { entityScope: "SPECIFIC_ENTITY_PERFORMANCE", entityType: "NODE", affectedEntityName: NODE } });

await tryAffects("CUSTOM SPECIFIC + entityType=APPLICATION",
  { affectedEntityType: "CUSTOM", affectedEntityScope: { entityScope: "SPECIFIC_ENTITY_PERFORMANCE", entityType: "APPLICATION", affectedEntityName: "Server & Infrastructure Monitoring" } });

await tryAffects("CUSTOM SPECIFIC + entityType=MACHINE_INSTANCE + name=app",
  { affectedEntityType: "CUSTOM", affectedEntityScope: { entityScope: "SPECIFIC_ENTITY_PERFORMANCE", entityType: "MACHINE_INSTANCE", affectedEntityName: "Server & Infrastructure Monitoring" } });

// Try with empty string instead of null
await tryAffects("CUSTOM SPECIFIC + entityType='' + name=''",
  { affectedEntityType: "CUSTOM", affectedEntityScope: { entityScope: "SPECIFIC_ENTITY_PERFORMANCE", entityType: "", affectedEntityName: "" } });
