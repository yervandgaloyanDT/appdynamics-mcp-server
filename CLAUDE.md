# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Project Overview

AppDynamics MCP Server — a Model Context Protocol server that exposes AppDynamics SaaS REST API data to MCP-compatible clients (Cursor, Claude Desktop, etc.). Provides 27 tools covering application monitoring, diagnostics, metric browsing, full dashboard CRUD, auto-build dashboards, dashboard import/export/file-save, health rule CRUD, and automated root cause analysis.

## Running

- **MCP server**: `npx tsx src/index.ts` (launched automatically by MCP clients via stdio transport)
- **Build**: `npm run build` (compiles to `dist/`)
- **Dev mode**: `npm run dev`
- **Install dependencies**: `npm install`

## Architecture

### Project Structure

```
src/
├── index.ts              # Entry point — creates McpServer, registers all tools
├── types.ts              # TypeScript interfaces for all AppDynamics entities
├── constants.ts          # Shared constants (timeouts, defaults, limits)
├── services/
│   ├── auth.ts           # OAuth2 token management with caching
│   └── api-client.ts     # Shared HTTP client (appdGet, appdPost, appdPut, appdDelete, appdGetRaw)
├── utils/
│   ├── error-handler.ts  # Centralized error → MCP response conversion
│   ├── app-resolver.ts   # Application name → ID resolver with cache
│   └── formatting.ts     # Response truncation, timestamp formatting, tables
└── tools/
    ├── applications.ts        # appd_get_applications
    ├── health-rules.ts        # appd_get_health_rules, appd_create_health_rule, appd_update_health_rule,
    │                          # appd_delete_health_rule, appd_enable_health_rule
    ├── health-violations.ts   # appd_get_health_violations
    ├── anomalies.ts           # appd_get_anomalies
    ├── business-transactions.ts # appd_get_business_transactions
    ├── bt-performance.ts      # appd_get_bt_performance
    ├── service-endpoints.ts   # appd_get_service_endpoints, appd_get_service_endpoint_performance
    ├── tiers-nodes.ts         # appd_get_tiers_and_nodes
    ├── backends.ts            # appd_get_backends
    ├── snapshots.ts           # appd_get_snapshots
    ├── errors.ts              # appd_get_errors
    ├── metrics.ts             # appd_get_metric_data, appd_browse_metric_tree
    ├── dashboards.ts          # appd_get_dashboards, appd_get_dashboard, appd_create_dashboard,
    │                          # appd_update_dashboard, appd_add_widget_to_dashboard,
    │                          # appd_clone_dashboard, appd_delete_dashboard, appd_export_dashboard,
    │                          # appd_auto_build_dashboard
    └── root-cause.ts          # appd_diagnose_issue
```

### Key Design Decisions

- **Modern MCP SDK**: Uses `McpServer` with `registerTool()` and Zod input schemas
- **App name resolution**: All tools accept application name OR numeric ID
- **Modular tools**: Each tool file exports a `register*Tools(server)` function
- **Shared API client**: Single authenticated HTTP client with consistent error handling
- **Response truncation**: Large responses are automatically truncated with pagination hints
- **Tool prefixing**: All tools prefixed with `appd_` to avoid conflicts with other MCP servers

### Authentication

- **Primary**: OAuth2 client credentials flow → `POST /controller/api/oauth/access_token`
- Client ID formatted as `clientName@accountName` when `APPD_ACCOUNT_NAME` is set
- Token cached with 5-minute safety margin before expiry
- **Fallback**: Direct API key if only `APPD_CLIENT_NAME` is set (no secret)

### Tools Summary (27 total)

| Category | Tools |
|---|---|
| Discovery | `appd_get_applications` |
| Health | `appd_get_health_rules`, `appd_create_health_rule`, `appd_update_health_rule`, `appd_delete_health_rule`, `appd_enable_health_rule`, `appd_get_health_violations`, `appd_get_anomalies` |
| Performance | `appd_get_business_transactions`, `appd_get_bt_performance`, `appd_get_service_endpoints`, `appd_get_service_endpoint_performance` |
| Infrastructure | `appd_get_tiers_and_nodes`, `appd_get_backends` |
| Diagnostics | `appd_get_snapshots`, `appd_get_errors` |
| Diagnostics+ | `appd_diagnose_issue` |
| Metrics | `appd_get_metric_data`, `appd_browse_metric_tree` |
| Dashboards | `appd_get_dashboards`, `appd_get_dashboard`, `appd_create_dashboard`, `appd_update_dashboard`, `appd_add_widget_to_dashboard`, `appd_clone_dashboard`, `appd_delete_dashboard`, `appd_export_dashboard`, `appd_import_dashboard`, `appd_save_dashboard_file`, `appd_auto_build_dashboard` |

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `APPD_URL` | Yes | AppDynamics controller base URL |
| `APPD_CLIENT_NAME` | Yes | OAuth client name or API key |
| `APPD_CLIENT_SECRET` | No | OAuth client secret (omit for API key auth) |
| `APPD_ACCOUNT_NAME` | No | Account name for `clientName@accountName` format |

## Key Details

- ES Modules (`"type": "module"` in package.json) — use `.js` extensions in imports
- TypeScript strict mode with `noUncheckedIndexedAccess`
- Target: ES2022, Module resolution: Node16
- Zod v3 for runtime input validation
- All API calls go through `services/api-client.ts` for consistent auth and error handling
- Dashboard APIs use `/restui/` endpoints (not the standard `/rest/` prefix)

### Dashboard Widget Format Systems

AppDynamics has **two distinct widget formats** — do not mix them:

| | Export format | RESTUI format |
|---|---|---|
| Used by | `auto_build`, `import`, `save_file` | `create`, `update`, `add_widget` |
| Widget type field | `widgetType: "AdvancedGraph"` | `type: "TIMESERIES_GRAPH"` |
| Metrics field | `dataSeriesTemplates[]` | `widgetsMetricMatchCriterias[]` |
| Endpoint | `POST /controller/CustomDashboardImportExportServlet` | `POST /controller/restui/dashboards/createDashboard` |
| Top-level key | `widgetTemplates` | `widgets` |

`buildExportWidgetPayload()` produces export format; `buildWidgetPayload()` produces RESTUI format.

## Guidelines

- Always update this file and README.md when adding new tools or fixing bugs
- Follow the existing tool registration pattern: one file per domain, Zod schemas, tool annotations
- Prefix all tool names with `appd_`
- Accept application name or ID wherever an application reference is needed
