#!/usr/bin/env node
/**
 * AppDynamics MCP Server
 *
 * A Model Context Protocol server that exposes AppDynamics REST API data
 * to MCP-compatible clients (Cursor, Claude Desktop, etc.).
 *
 * Provides tools for:
 *  - Application discovery and monitoring
 *  - Health rule CRUD, violation tracking, and anomaly detection
 *  - Business transaction and service endpoint performance analysis
 *  - Infrastructure topology (tiers, nodes, backends)
 *  - Transaction snapshots and error diagnostics
 *  - Automated root cause analysis (appd_diagnose_issue)
 *  - Metric browsing and querying
 *  - Dashboard CRUD plus auto-build, import/export, and file save
 */

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Single source of truth for the version — resolves to the project package.json
// from both src/ (tsx) and dist/ (built).
const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

// Tool registrations
import { registerApplicationTools } from "./tools/applications.js";
import { registerHealthViolationTools } from "./tools/health-violations.js";
import { registerHealthRuleTools } from "./tools/health-rules.js";
import { registerBusinessTransactionTools } from "./tools/business-transactions.js";
import { registerBtPerformanceTools } from "./tools/bt-performance.js";
import { registerTiersNodesTools } from "./tools/tiers-nodes.js";
import { registerSnapshotTools } from "./tools/snapshots.js";
import { registerErrorTools } from "./tools/errors.js";
import { registerMetricTools } from "./tools/metrics.js";
import { registerAnomalyTools } from "./tools/anomalies.js";
import { registerBackendTools } from "./tools/backends.js";
import { registerServiceEndpointTools } from "./tools/service-endpoints.js";
import { registerDashboardTools } from "./tools/dashboards.js";
import { registerRootCauseTools } from "./tools/root-cause.js";

// ── Server Setup ─────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "appdynamics-mcp-server",
  version,
});

// ── Register All Tools ───────────────────────────────────────────────────────

// Discovery & overview
registerApplicationTools(server);

// Health monitoring
registerHealthRuleTools(server);
registerHealthViolationTools(server);
registerAnomalyTools(server);

// Application performance
registerBusinessTransactionTools(server);
registerBtPerformanceTools(server);
registerServiceEndpointTools(server);

// Infrastructure
registerTiersNodesTools(server);
registerBackendTools(server);

// Diagnostics
registerSnapshotTools(server);
registerErrorTools(server);
registerRootCauseTools(server);

// Metrics
registerMetricTools(server);

// Dashboards
registerDashboardTools(server);

// ── Start ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`AppDynamics MCP Server v${version} running via stdio`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
