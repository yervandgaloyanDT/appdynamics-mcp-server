# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Project Overview

AppDynamics MCP Server — a Model Context Protocol server that exposes AppDynamics SaaS REST API data to MCP-compatible clients (Cursor, Claude Desktop, etc.). Provides 30 tools covering application monitoring, diagnostics, metric browsing, full dashboard CRUD, auto-build dashboards, dashboard import/export/file-save, health rule CRUD, and automated root cause analysis.

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
│   ├── time-range.ts     # Shared time-range schema → AppD query params
│   ├── concurrency.ts    # mapWithConcurrency — bounded fan-out
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
    ├── dashboard-payloads.ts  # Pure widget/dashboard payload builders (no I/O, unit-tested)
    └── root-cause.ts          # appd_diagnose_issue

test/
├── dashboard-payloads.test.ts # Vitest unit tests for the payload builders
├── time-range.test.ts         # Range-type selection, timestamp parsing, validation
├── formatting.test.ts         # Response truncation stays within CHARACTER_LIMIT
├── auth.test.ts               # Token caching, in-flight dedupe, invalidation
├── concurrency.test.ts        # Order preservation and concurrency ceiling
├── error-handler.test.ts      # Status mapping and error-body capping
└── fixtures/                  # RESTUI + export JSON captured from real working dashboards
                                # (ground truth for widget/metric criteria shapes)
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

### Tools Summary (30 total)

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

### Time ranges

Never hardcode `time-range-type` / `duration-in-mins` in a tool. Spread
`TimeRangeSchema` into the tool's `inputSchema` and call `resolveTimeRange(input, DEFAULT)`,
then spread `range.params` into the `appdGet` call. The helper picks the correct AppD
range type from which arguments were supplied:

| Supplied | Range type |
|---|---|
| *(none)* / `durationInMins` | `BEFORE_NOW` |
| `startTime` + `endTime` | `BETWEEN_TIMES` |
| `endTime` [+ `durationInMins`] | `BEFORE_TIME` |
| `startTime` [+ `durationInMins`] | `AFTER_TIME` |

`resolveTimeRange` throws on contradictory input (all three arguments) or an inverted
window; the tool's existing `catch` → `handleError` surfaces the message. Use
`range.description` for any human-readable `timeRange` field, and `precedingWindow(range)`
when a baseline comparison window is needed (see `root-cause.ts`).

Verified live: all four range types are accepted by `/rest/applications/{id}/metric-data`.
Note that AppDynamics rolls older data into coarser buckets — a narrow window far in the
past can return nothing while a wider window over the same period returns one aggregate
bucket labelled with the **window start**, not the data's actual timestamp.

### Auth and fan-out

- `getAccessToken()` shares one in-flight OAuth request across concurrent callers;
  `invalidateToken()` clears the cache and is called by `api-client` on a 401 (retried once).
- Multipart requests (`appdPostFormData`) opt out of the 401 retry — the body cannot be replayed.
- Any tool that iterates all applications or tiers must use `mapWithConcurrency`, never a
  bare `Promise.all` over the full list.

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
Both live in `src/tools/dashboard-payloads.ts` (pure, unit-tested — keep them free of I/O).

### Widget rendering rules (learned from live-API interrogation + working dashboards)

These are load-bearing: getting any of them wrong makes widgets save "successfully" but render empty.

- **Valid RESTUI widget `type` enum**: ANALYTICS, FLOWMAP, GAUGE, HEALTH_LIST, IFRAME, IMAGE,
  ISSUE_TRACKING, LABEL, LIST, LOG_TAIL, METRIC_LABEL, MULTI_SERIES_HEALTH_STATUS, PIE,
  STATUS_LIGHT, STREAMING_GRAPH, SUPER, TIMESERIES_GRAPH.
  `TEXT` and `METRIC_VALUE` are **not valid** — the MCP tools accept them as aliases and map
  them to `LABEL` / `METRIC_LABEL` via `toRestuiWidgetType()`.
- **HEALTH_LIST scoping** (green/yellow/red circles): `entitySelectionType: "SPECIFIED"` +
  `entityIds: [healthRuleIds]` + `entityType: "POLICY"`; use `"ALL"` to show every rule.
  The import servlet drops this, so create/import flows re-patch via `patchHealthListWidgets()`.
- **HEALTH_LIST display modes**: `showPie` and `showBarPie` are mutually exclusive
  (`showPie: true` + `showBarPie: false` = pie chart; add `innerRadius: 30-40` for a donut;
  `showList: false` hides the rule list). Exposed on the widget schema as
  `showPie`/`innerRadius`/`showList` and re-applied post-import by `patchHealthListWidgets()`.
- **Metric criteria** (`buildRestuiMetricSeries`) — three forms, each verified live against
  `POST /restui/dashboards/widgetData` (the endpoint the dashboard UI renders from):
  - **BT paths WITH btIds**: `BT_AFFECTED_EMC`/`SPECIFIC` + `TIER_AVERAGE`, `inputMetricText: false`,
    path stored as `Root||Business Transaction Performance||<leaf>`.
  - **App-scope paths** (Overall Application Performance, Backends, Service Endpoints, Errors,
    and BT paths WITHOUT btIds): `OVERALL_AFFECTED_EMC` with `type: "APPLICATION"` (or
    `"SPECIFIC_TIERS"` + `componentIds` when tierIds given), `inputMetricText: false`,
    path `Root||<category>||<rest>`, metricType/scope null. This resolves the true
    `BTM|Application Summary|<metric>` aggregate. BT-style criteria for these paths render
    one series per BT on graphs and `--` on labels; the typed-absolute INFRA form returns no data.
  - **Node metrics** (JVM, Hardware Resources, Agent, Custom Metrics, or
    `Application Infrastructure Performance|<tier>|<rest>`): `INFRASTRUCTURE_AFFECTED_EMC`/`NODES`/`ANY`
    with the **node-relative** path (`toNodeRelativePath` strips the `AIP|<tier>|` prefix) typed as
    text (`inputMetricText: true`). Absolute AIP paths return no data in any other form.
  - `rollupMetricData`: `false` for TIMESERIES_GRAPH, `true` for value widgets (METRIC_LABEL/GAUGE/PIE).
  - NOTE: `GET /rest/applications/{id}/metric-data` and dashboard `widgetData` resolve paths
    DIFFERENTLY — a path returning data in metric-data can still render empty on a dashboard.
    `widgetData` only works with a browser session (500s under OAuth tokens).
- **Two-step bind**: new widgets are saved without criteria, then criteria are bound in a second
  `updateDashboard` using the **server-assigned** widget `id`/`guid` (client-generated ids → 500).
- Health rules come from `/controller/alerting/rest/v1/applications/{id}/health-rules`
  (the legacy `/rest/applications/{id}/health-rules` returns 400).

## Testing

- `npm test` — vitest unit tests for the payload builders against `test/fixtures/` ground truth
- `node scripts/verify-dashboard-fixes.mjs` — end-to-end: drives the real MCP server over stdio,
  creates dashboards on the live controller, asserts persisted RESTUI shapes and metric data.
  Requires `APPD_URL`, `APPD_CLIENT_NAME`, `APPD_CLIENT_SECRET`, `APPD_ACCOUNT_NAME` env vars.
  Delete the `MCP * Verification *` dashboards it creates after reviewing them.

## Guidelines

- Always update this file and README.md when adding new tools or fixing bugs
- Follow the existing tool registration pattern: one file per domain, Zod schemas, tool annotations
- Prefix all tool names with `appd_`
- Accept application name or ID wherever an application reference is needed
