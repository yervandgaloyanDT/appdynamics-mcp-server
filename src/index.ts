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
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

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

function buildServer(): McpServer {
  const server = new McpServer({
    name: "appdynamics-mcp-server",
    version,
  });

  // ── Register All Tools ─────────────────────────────────────────────────────

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

  return server;
}

// ── Start ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if ((process.env.TRANSPORT ?? "stdio") === "http") {
    await serveHttp();
    return;
  }
  const transport = new StdioServerTransport();
  await buildServer().connect(transport);
  console.error(`AppDynamics MCP Server v${version} running via stdio`);
}

async function serveHttp(): Promise<void> {
  const port = Number(process.env.PORT ?? 8080);
  const path = process.env.MCP_PATH ?? "/mcp";

  const httpServer = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    void handleApiRequest(req, res);
  });

  async function handleApiRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== path) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }
    // Stateless: a fresh McpServer + transport per request (SDK pattern).
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
      }
      if (!res.writableEnded) {
        res.end("Internal Server Error");
      }
    }
  }

  await new Promise<void>((resolve) => httpServer.listen(port, "0.0.0.0", resolve));
  console.error(
    `AppDynamics MCP Server v${version} running via HTTP at http://0.0.0.0:${port}${path}`
  );
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
