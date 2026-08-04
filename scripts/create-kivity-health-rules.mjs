#!/usr/bin/env node
/**
 * Creates health rules for each monitored service found under:
 *   Application Infrastructure Performance|Root|Individual Nodes|Kivity-Ultra-7
 *
 * For each service that exposes a "Status" and/or "ResponseCode" metric:
 *   - WARNING  (yellow): Status  != 4
 *   - CRITICAL (red)   : ResponseCode != 200
 *
 * Then creates a dashboard with one HealthListWidget (pie mode) per health rule.
 *
 * Usage: node scripts/create-kivity-health-rules.mjs
 */

import https from "https";
import { URL } from "url";
import { randomUUID } from "crypto";
import { BASE, tokenFormBody } from "./_appd-env.mjs";

// ── Config ────────────────────────────────────────────────────────────────────

// Credentials come from .env / the environment — never hardcode them here.
const BASE_URL = BASE;

const APP_NAME        = "Server & Infrastructure Monitoring";
const TIER_NAME       = "Root";
const NODE_NAME       = "ip-10-0-1-163.eu-west-1.compute.internal";
const ROOT_METRIC_PATH = `Application Infrastructure Performance|${TIER_NAME}|Individual Nodes|${NODE_NAME}|Custom Metrics|URL Monitor`;

// Patterns for metric names we care about (AppD URL Monitor extension naming)
const STATUS_RE    = /^status$/i;
const RESP_CODE_RE = /^response\s*code$/i;

// ── Low-level HTTP ────────────────────────────────────────────────────────────

function rawRequest(method, urlStr, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const bodyBuf = body ? Buffer.from(typeof body === "string" ? body : JSON.stringify(body)) : null;

    const opts = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method,
      headers: {
        ...headers,
        ...(bodyBuf ? { "Content-Length": bodyBuf.length } : {}),
      },
    };

    const req = https.request(opts, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const data = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        } else {
          reject(new Error(`HTTP ${res.statusCode} ${method} ${u.pathname}: ${data.slice(0, 400)}`));
        }
      });
    });
    req.on("error", reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// ── Auth ──────────────────────────────────────────────────────────────────────

let _token = null;

async function getToken() {
  if (_token) return _token;
  const res  = await rawRequest("POST", `${BASE_URL}/controller/api/oauth/access_token`, tokenFormBody(), {
    "Content-Type": "application/x-www-form-urlencoded",
  });
  _token = res.access_token;
  if (!_token) throw new Error("No access_token in response: " + JSON.stringify(res));
  return _token;
}

async function appdGet(path) {
  const token = await getToken();
  const url   = path.startsWith("http") ? path : `${BASE_URL}${path}`;
  return rawRequest("GET", url, null, {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/json",
  });
}

async function appdPost(path, body) {
  const token = await getToken();
  return rawRequest("POST", `${BASE_URL}${path}`, body, {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
  });
}

async function importServlet(dashboardJson) {
  const token    = await getToken();
  const boundary = `----AppdBoundary${randomUUID().replace(/-/g, "")}`;
  const fileBody = JSON.stringify(dashboardJson, null, 2);

  // Manually build multipart/form-data (no external deps)
  const CRLF = "\r\n";
  const parts = [
    `--${boundary}${CRLF}`,
    `Content-Disposition: form-data; name="file"; filename="dashboard.json"${CRLF}`,
    `Content-Type: application/json${CRLF}`,
    CRLF,
    fileBody,
    CRLF,
    `--${boundary}--${CRLF}`,
  ];
  const bodyBuf = Buffer.from(parts.join(""), "utf8");

  return new Promise((resolve, reject) => {
    const u = new URL(`${BASE_URL}/controller/CustomDashboardImportExportServlet`);
    const opts = {
      hostname: u.hostname,
      port: 443,
      path: u.pathname,
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": bodyBuf.length,
      },
    };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const data = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        } else {
          reject(new Error(`HTTP ${res.statusCode} import servlet: ${data.slice(0, 500)}`));
        }
      });
    });
    req.on("error", reject);
    req.write(bodyBuf);
    req.end();
  });
}

// ── App Resolution ────────────────────────────────────────────────────────────

async function getAppId() {
  // Try list first; SIM app doesn't appear in the list but does respond to single-app lookup
  const list = await appdGet(`/controller/rest/applications?output=JSON`);
  const fromList = (Array.isArray(list) ? list : []).find(a => a.name === APP_NAME);
  if (fromList) return fromList.id;

  // Fallback: single-app endpoint (works for SIM / hidden apps)
  const single = await appdGet(`/controller/rest/applications/${encodeURIComponent(APP_NAME)}?output=JSON`);
  const fromSingle = (Array.isArray(single) ? single : []).find(a => a.name === APP_NAME);
  if (fromSingle) return fromSingle.id;

  throw new Error(`App not found: "${APP_NAME}"`);
}

// ── Metric Tree Browsing ──────────────────────────────────────────────────────

async function browseFolder(appId, path) {
  const enc = encodeURIComponent(path);
  try {
    const res = await appdGet(`/controller/rest/applications/${appId}/metrics?metric-path=${enc}&output=JSON`);
    return Array.isArray(res) ? res : [];
  } catch (e) {
    console.warn(`    [browse warn] ${path.split("|").slice(-2).join("|")}: ${e.message.split(":")[0]}`);
    return [];
  }
}

async function findLeafMetrics(appId, path, depth = 0) {
  if (depth > 8) return [];
  const items   = await browseFolder(appId, path);
  const results = [];
  for (const item of items) {
    const fullPath = `${path}|${item.name}`;
    if (item.type === "folder") {
      results.push(...await findLeafMetrics(appId, fullPath, depth + 1));
    } else {
      results.push({ fullPath, name: item.name });
    }
  }
  return results;
}

// ── Service Grouping ──────────────────────────────────────────────────────────

function groupByService(leafMetrics) {
  const map = new Map(); // relativePrefix → { status: null|path, responseCode: null|path }

  for (const { fullPath, name } of leafMetrics) {
    if (!fullPath.startsWith(ROOT_METRIC_PATH + "|")) continue;
    const relativePath   = fullPath.slice(ROOT_METRIC_PATH.length + 1); // strips "ROOT_PATH|"
    const parts          = relativePath.split("|");
    if (parts.length < 2) continue;

    const metricName     = parts[parts.length - 1];
    const servicePrefix  = parts.slice(0, -1).join("|");

    if (!map.has(servicePrefix)) map.set(servicePrefix, { status: null, responseCode: null });
    const svc = map.get(servicePrefix);

    if (STATUS_RE.test(metricName))     svc.status       = relativePath;
    else if (RESP_CODE_RE.test(metricName)) svc.responseCode = relativePath;
  }

  return [...map.entries()]
    .filter(([, v]) => v.status || v.responseCode)
    .map(([prefix, v]) => ({ servicePrefix: prefix, ...v }));
}

// ── Health Rule Builder ───────────────────────────────────────────────────────

/**
 * Build one condition object in the SIM alerting API format.
 * metricPath = FULL absolute path (e.g. Application Infrastructure Performance|Root|...|Status)
 * compareCondition = e.g. "NOT_EQUALS", "GREATER_THAN_SPECIFIC_VALUE", "LESS_THAN_SPECIFIC_VALUE"
 */
function cond(name, metricPath, compareCondition, compareValue) {
  return {
    name,
    shortName: "A",
    evaluateToTrueOnNoData: false,
    violationStatusOnNoData: "UNKNOWN",
    wildcardMetricMatchType: "DEFAULT_ALL_METRIC_PATH",
    evalDetail: {
      evalDetailType: "SINGLE_METRIC",
      metricAggregateFunction: "VALUE",
      metricPath,
      metricEvalDetail: {
        metricEvalDetailType: "SPECIFIC_TYPE",
        compareCondition,
        compareValue,
      },
      inputMetricText: false,
    },
    triggerEnabled: false,
    minimumTriggers: 1,
  };
}

function criteria(conditions) {
  return {
    conditionAggregationType: "ALL",
    conditionExpression: null,
    conditions,
    evalMatchingCriteria: { matchType: "ANY", value: null },
  };
}

/**
 * statusPath / responseCodePath = relative paths from ROOT_METRIC_PATH,
 * e.g. "ACTIVEMQ_b2X|ACTIVEMQ_b2X_1_mglx264p|Status"
 * We prefix them with ROOT_METRIC_PATH to form the full absolute path.
 */
function buildHealthRulePayload(ruleName, statusPath, responseCodePath) {
  const fullStatus  = statusPath       ? ROOT_METRIC_PATH + "|" + statusPath       : null;
  const fullRespCode = responseCodePath ? ROOT_METRIC_PATH + "|" + responseCodePath : null;

  return {
    name: ruleName,
    enabled: true,
    useDataFromLastNMinutes: 5,
    waitTimeAfterViolation: 5,
    splitEventsByMetrics: false,
    scheduleName: "Always",
    affects: {
      affectedEntityType: "CUSTOM",
      affectedEntityScope: {
        entityScope: "SPECIFIC_ENTITY_PERFORMANCE",
        entityType: "SERVER",
        affectedEntityName: NODE_NAME,
      },
    },
    evalCriterias: {
      // CRITICAL = red: ResponseCode != 200
      criticalCriteria: fullRespCode
        ? criteria([cond("Response Code != 200", fullRespCode, "NOT_EQUALS", 200)])
        : null,
      // WARNING = yellow: Status != 4
      warningCriteria: fullStatus
        ? criteria([cond("Status != 4",           fullStatus,  "NOT_EQUALS", 4)])
        : null,
    },
  };
}

// ── Dashboard Builder ─────────────────────────────────────────────────────────

const C_WHITE      = 16777215; // #FFFFFF
const C_LIGHT_GRAY = 15856629; // #F1F1F5
const C_DARK       = 1646891;  // #19222B
const C_BORDER     = 14408667; // #DBDBDB

function healthListWidget(title, ruleName, x, y, w, h) {
  return {
    widgetType: "HealthListWidget",
    title,
    height: h,
    width: w,
    minHeight: 0,
    minWidth: 0,
    x,
    y,
    label: null,
    description: null,
    drillDownUrl: null,
    openUrlInCurrentTab: false,
    useMetricBrowserAsDrillDown: true,
    drillDownActionType: null,
    backgroundColor: C_WHITE,
    backgroundColors: null,
    backgroundColorsStr: `${C_WHITE},${C_WHITE}`,
    color: C_DARK,
    fontSize: 11,
    useAutomaticFontSize: false,
    borderEnabled: true,
    borderThickness: 1,
    borderColor: C_BORDER,
    backgroundAlpha: 1,
    showValues: false,
    formatNumber: true,
    numDecimals: 0,
    removeZeros: true,
    compactMode: false,
    showTimeRange: false,
    renderIn3D: false,
    showLegend: null,
    legendPosition: null,
    legendColumnCount: null,
    timeRangeSpecifierType: "UNKNOWN",
    startTime: null,
    endTime: null,
    minutesBeforeAnchorTime: 15,
    isGlobal: true,
    propertiesMap: null,
    dataSeriesTemplates: null,
    // HealthListWidget-specific
    applicationReference: null,
    entityReferences: [{
      applicationName: APP_NAME,
      entityType: "POLICY",
      entityName: ruleName,
      scopingEntityType: null,
      scopingEntityName: null,
      subtype: null,
      uniqueKey: null,
    }],
    entityType: "POLICY",
    entitySelectionType: "SPECIFIC",
    iconSize: 18,
    iconPosition: "LEFT",
    showSearchBox: false,
    showList: true,
    showListHeader: false,
    showBarPie: true,
    showPie: true,
    showCurrentHealthStatus: false,
    innerRadius: 0,
    aggregationType: "RATIO",
  };
}

function buildDashboard(dashName, ruleNames) {
  const COLS     = 6;
  const W        = 2;   // grid units per widget (12/6)
  const H        = 2;   // grid units tall
  const widgets  = ruleNames.map((name, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    return healthListWidget(name, name, col * W, row * H, W, H);
  });
  const rows      = Math.ceil(ruleNames.length / COLS);
  const dashH     = Math.max(rows * H * 80 + 120, 400);

  return {
    schemaVersion: null,
    dashboardFormatVersion: "4.0",
    name: dashName,
    description: `URL Monitor health status for ${NODE_NAME} (auto-generated)`,
    properties: null,
    templateEntityType: "APPLICATION_COMPONENT_NODE",
    associatedEntityTemplates: null,
    timeRangeSpecifierType: "UNKNOWN",
    minutesBeforeAnchorTime: -1,
    startDate: null,
    endDate: null,
    refreshInterval: 60000,
    backgroundColor: C_LIGHT_GRAY,
    color: C_LIGHT_GRAY,
    height: dashH,
    width: 1440,
    canvasType: "CANVAS_TYPE_GRID",
    layoutType: "",
    widgetTemplates: widgets,
    warRoom: false,
    template: false,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Kivity-Ultra-7 → Health Rules + Dashboard Builder");
  console.log("═══════════════════════════════════════════════════════════\n");

  // Step 1 — Auth
  process.stdout.write("1. Authenticating … ");
  await getToken();
  console.log("✓");

  // Step 2 — App ID
  process.stdout.write(`2. Resolving app "${APP_NAME}" … `);
  const appId = await getAppId();
  console.log(`✓  (ID ${appId})`);

  // Step 3 — Browse metric tree
  console.log(`\n3. Browsing metric tree (recursive, may take a moment)…`);
  console.log(`   ${ROOT_METRIC_PATH}`);
  const allLeafMetrics = await findLeafMetrics(appId, ROOT_METRIC_PATH);
  console.log(`   ✓ ${allLeafMetrics.length} leaf metrics found`);

  if (allLeafMetrics.length === 0) {
    console.error("\n✗ No metrics returned. Verify the tier/node name and that the agent is active.");
    console.error(`  Check: ${BASE_URL}/controller/rest/applications/${appId}/metrics?metric-path=${encodeURIComponent(ROOT_METRIC_PATH)}&output=JSON`);
    process.exit(1);
  }

  // Step 4 — Group by service
  console.log("\n4. Identifying services with Status / ResponseCode metrics…");
  const services = groupByService(allLeafMetrics);

  if (services.length === 0) {
    console.log("\n  No services matching status/responseCode patterns found.");
    console.log("  All discovered leaf metrics:");
    allLeafMetrics.forEach(m => console.log(`    ${m.fullPath}`));
    process.exit(1);
  }

  console.log(`   ✓ ${services.length} service(s):`);
  services.slice(0, 8).forEach(svc => {
    const parts     = svc.servicePrefix.split("|");
    const label     = parts.slice(-2).join("/");
    const statusTag = svc.status       ? "Status ✓" : "Status ✗";
    const respTag   = svc.responseCode ? "Code ✓"   : "Code ✗";
    console.log(`     • ${label.padEnd(50)}  ${statusTag}  ${respTag}`);
  });
  if (services.length > 8) console.log(`     … and ${services.length - 8} more`);

  // Step 5 — Create health rules
  const alertBase = `/controller/alerting/rest/v1/applications/${appId}/health-rules`;
  console.log(`\n5. Creating ${services.length} health rule(s)…`);

  const createdRules = [];
  let ok = 0, fail = 0;
  for (let i = 0; i < services.length; i++) {
    const svc      = services[i];
    const parts    = svc.servicePrefix.split("|");
    // group/instance  e.g. "ACTIVEMQ_b2X/ACTIVEMQ_b2X_1_mglx264p"
    const ruleName = "URL: " + parts.slice(-2).join("/");
    const payload  = buildHealthRulePayload(ruleName, svc.status, svc.responseCode);

    try {
      const rule = await appdPost(alertBase, payload);
      ok++;
      if (ok <= 5 || ok % 20 === 0) console.log(`   ✓ [${ok}/${services.length}] "${rule.name}" (ID ${rule.id})`);
      createdRules.push(rule);
    } catch (e) {
      fail++;
      console.error(`   ✗ [${i+1}] "${ruleName}": ${e.message}`);
    }
    // Throttle to avoid rate-limiting (100 ms between calls)
    if (i < services.length - 1) await new Promise(r => setTimeout(r, 100));
  }
  console.log(`   Done: ${ok} created, ${fail} failed`);

  if (createdRules.length === 0) {
    console.error("\nNo health rules were created — aborting dashboard build.");
    process.exit(1);
  }

  // Step 6 — Build + import dashboard
  const dashName = `URL Monitor Service Health`;
  console.log(`\n6. Building dashboard "${dashName}" (${createdRules.length} widgets)…`);
  const dashJson = buildDashboard(dashName, createdRules.map(r => r.name));

  console.log("7. Importing dashboard via servlet…");
  try {
    const result = await importServlet(dashJson);

    // Three-tier ID extraction
    let dashId = null;
    if (result && typeof result === "object" && !Array.isArray(result)) {
      dashId = result.id ?? result.dashboardId ?? null;
    }
    if (!dashId && Array.isArray(result) && result[0]) {
      dashId = result[0].id ?? result[0].dashboardId ?? null;
    }
    if (!dashId) {
      // Fallback: look up by name
      try {
        const all = await rawRequest("GET", `${BASE_URL}/controller/restui/dashboards/getAllDashboardsByType/false`,
          null, { "Authorization": `Bearer ${await getToken()}`, "Accept": "application/json" });
        const found = (Array.isArray(all) ? all : []).find(d => d.name === dashName);
        if (found) dashId = found.id;
      } catch { /* ignore */ }
    }

    if (dashId) {
      const url = `${BASE_URL}/controller/#/location=DASHBOARD_DETAIL&timeRange=last_15_minutes.BEFORE_NOW.-1.-1.60&dashboardId=${dashId}`;
      console.log(`   ✓ Dashboard created  →  ID ${dashId}`);
      console.log(`   🔗 ${url}`);
    } else {
      console.log("   ✓ Dashboard imported (ID unknown — check AppDynamics Dashboards list)");
      console.log(`   Raw response: ${JSON.stringify(result).slice(0, 300)}`);
    }
  } catch (e) {
    console.error(`   ✗ Dashboard import failed: ${e.message}`);
  }

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log(`  Created ${createdRules.length} health rule(s)  +  1 dashboard`);
  console.log("═══════════════════════════════════════════════════════════\n");
}

main().catch(e => {
  console.error("\nFatal:", e.message);
  process.exit(1);
});
