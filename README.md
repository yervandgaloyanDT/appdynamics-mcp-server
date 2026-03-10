# AppDynamics MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io/) server that gives LLM clients (Cursor, Claude Desktop, etc.) full access to your AppDynamics monitoring data — plus the ability to create and manage dashboards and health rules.

## Features

**30 tools** across 8 categories:

- **Discovery**: List and search applications by name
- **Health Monitoring**: Full health rule CRUD, violations, and anomaly detection
- **Application Performance**: Business transactions, service endpoints, and their metrics
- **Infrastructure**: Tiers, nodes, and backend/remote service dependencies
- **Diagnostics**: Transaction snapshots and error events
- **Root Cause Analysis**: Automated composite diagnosis across all signal types
- **Metrics**: Browse the metric tree and query any metric with rollup support
- **Dashboards**: Full CRUD — list, view, create, update, add widgets, clone, delete, export, import, auto-build, per-rule health status widgets

### Key capabilities

- **Natural language friendly**: Accept application names, not just IDs
- **Metric tree browser**: Discover available metrics interactively, including custom/machine-agent metrics
- **Rollup control**: Per-widget rollup for time-series vs. aggregate metric views
- **Dashboard auto-builder**: Create full multi-section dashboards from a single prompt
- **HealthListWidget scoping**: Each widget can be pinned to a specific health rule (not "all rules")
- **Health rule CRUD**: Create, update, enable/disable, and delete health rules — including custom metrics scoped to a specific tier or node
- **Smart defaults**: Sensible time ranges and result limits out of the box

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Required variables:

| Variable | Description |
|---|---|
| `APPD_URL` | Controller base URL (e.g., `https://mycompany.saas.appdynamics.com`) |
| `APPD_CLIENT_NAME` | OAuth client name or API key |
| `APPD_CLIENT_SECRET` | OAuth client secret |
| `APPD_ACCOUNT_NAME` | Account name (for `clientName@accountName` format) |

### 3. Add to your MCP client

**Cursor** (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "appdynamics": {
      "command": "npx",
      "args": ["tsx", "src/index.ts"],
      "cwd": "/path/to/appdynamics-mcp-server",
      "env": {
        "APPD_URL": "https://your-controller.saas.appdynamics.com",
        "APPD_CLIENT_NAME": "your-client-name",
        "APPD_CLIENT_SECRET": "your-client-secret",
        "APPD_ACCOUNT_NAME": "your-account-name"
      }
    }
  }
}
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "appdynamics": {
      "command": "npx",
      "args": ["tsx", "/path/to/appdynamics-mcp-server/src/index.ts"],
      "env": {
        "APPD_URL": "https://your-controller.saas.appdynamics.com",
        "APPD_CLIENT_NAME": "your-client-name",
        "APPD_CLIENT_SECRET": "your-client-secret",
        "APPD_ACCOUNT_NAME": "your-account-name"
      }
    }
  }
}
```

## Tools Reference

### Discovery

| Tool | Description |
|---|---|
| `appd_get_applications` | List all monitored applications (with optional name filter) |

### Health Monitoring

| Tool | Description |
|---|---|
| `appd_get_health_rules` | List health rules or get details of a specific rule |
| `appd_create_health_rule` | Create a new health rule with warning and/or critical conditions. Supports `OVERALL_APPLICATION_PERFORMANCE`, `BUSINESS_TRANSACTION_PERFORMANCE`, `TIER_NODE_HEALTH`, and `CUSTOM` entity types. Use `affectedTier` or `affectedNode` to scope rules to a specific tier/node for custom metrics. |
| `appd_update_health_rule` | Update an existing health rule's name, conditions, thresholds, or scope |
| `appd_delete_health_rule` | Permanently delete a health rule |
| `appd_enable_health_rule` | Enable or disable a health rule |
| `appd_get_health_violations` | Get health rule violations for one or all apps |
| `appd_get_anomalies` | Get anomaly events (open-only by default) |

### Application Performance

| Tool | Description |
|---|---|
| `appd_get_business_transactions` | List BTs for an application |
| `appd_get_bt_performance` | Get response time, throughput, errors for a BT |
| `appd_get_service_endpoints` | List service endpoints (API-level granularity) |
| `appd_get_service_endpoint_performance` | Get performance metrics for a service endpoint |

### Infrastructure

| Tool | Description |
|---|---|
| `appd_get_tiers_and_nodes` | Get tiers with their nodes (agents, machines, IPs) |
| `appd_get_backends` | List backend dependencies (databases, APIs, caches, queues) |

### Diagnostics

| Tool | Description |
|---|---|
| `appd_get_snapshots` | Get transaction snapshots (deep diagnostic captures) |
| `appd_get_errors` | Get error and exception events |

### Root Cause Analysis

| Tool | Description |
|---|---|
| `appd_diagnose_issue` | Automated root cause analysis — fetches violations, anomalies, error events, and snapshots in parallel, then returns ranked candidates, a merged timeline, error breakdown, and investigation steps |

### Metrics

| Tool | Description |
|---|---|
| `appd_browse_metric_tree` | Browse the metric hierarchy to discover available metrics, including custom machine-agent metrics |
| `appd_get_metric_data` | Query any metric by path. Supports `rollup` control: `true` returns a single aggregated value, `false` returns individual time-series data points |

### Dashboards

| Tool | Description |
|---|---|
| `appd_get_dashboards` | List all custom dashboards |
| `appd_get_dashboard` | Get full dashboard definition with widgets |
| `appd_create_dashboard` | Create a new dashboard with optional widgets |
| `appd_update_dashboard` | Update dashboard properties and/or widgets |
| `appd_add_widget_to_dashboard` | Add a single widget without replacing existing ones |
| `appd_clone_dashboard` | Clone a dashboard with a new name |
| `appd_delete_dashboard` | Delete a dashboard (permanent) |
| `appd_export_dashboard` | Export dashboard as portable JSON |
| `appd_import_dashboard` | Create a new dashboard from a saved JSON definition |
| `appd_save_dashboard_file` | Build a complete dashboard JSON file locally without creating anything in AppDynamics — ready to edit and import |
| `appd_auto_build_dashboard` | Auto-discover tiers, BTs, and health rules, then create a complete multi-section dashboard in one shot |

#### Dashboard widget types

| Widget type | Description |
|---|---|
| `TIMESERIES_GRAPH` | Time-series line chart for one or more metrics |
| `METRIC_VALUE` | Single aggregated number (gauge tile) |
| `GAUGE` | Gauge dial |
| `PIE` | Pie chart |
| `HEALTH_LIST` | Health rule status list. Set `healthRuleIds: [id]` to pin a widget to a specific health rule instead of showing all rules for the application. |
| `TEXT` | Static text / label |

## Example Conversations

**"What's the health status of my production apps?"**
→ Uses `appd_get_applications` + `appd_get_health_violations` + `appd_get_anomalies`

**"Show me the slowest business transactions for the Orders app"**
→ Uses `appd_get_business_transactions` + `appd_get_bt_performance`

**"What databases does the Payment service connect to?"**
→ Uses `appd_get_backends` with typeFilter="JDBC"

**"Create a health rule that fires when Custom Metrics|RequestCount > 1000 on the WebTier"**
→ Uses `appd_create_health_rule` with affectedEntityType="TIER_NODE_HEALTH", affectedTier="WebTier", metricPath="Custom Metrics|RequestCount"

**"Create a dashboard for the Checkout app with response time and error rate"**
→ Uses `appd_get_applications` → `appd_browse_metric_tree` → `appd_create_dashboard`

**"Build me a full monitoring dashboard for the Orders app"**
→ Uses `appd_auto_build_dashboard` — auto-discovers all tiers, BTs, and health rules, creates a complete dashboard in one shot

**"Create one health widget per URL Monitor service, each scoped to its own rule"**
→ Uses `appd_create_health_rule` (one per service) + `appd_create_dashboard` with `healthRuleIds` on each `HEALTH_LIST` widget

**"Clone the production monitoring dashboard for staging"**
→ Uses `appd_get_dashboards` → `appd_clone_dashboard`

**"Why is my Payment app slow? Diagnose the last hour"**
→ Uses `appd_diagnose_issue` with application="Payment", durationInMins=60 — returns ranked root cause candidates, merged event timeline, error class breakdown, and step-by-step investigation guide

**"Are there any errors spiking in the Orders app right now?"**
→ Uses `appd_diagnose_issue` with application="Orders", focus="errors"

## Health Rules — Custom Metrics

Custom metrics reported by machine agents are stored per-node under:
```
Application Infrastructure Performance|{Tier}|Individual Nodes|{Node}|Custom Metrics|{MetricName}
```

When creating health rules for custom metrics, use `affectedEntityType=TIER_NODE_HEALTH` and provide the **relative** metric path (not the full absolute path):

```
affectedEntityType: "TIER_NODE_HEALTH"
affectedNode: "my-server-hostname"          # scope to specific node
metricPath: "Custom Metrics|MyMetric"       # relative path only
```

## Architecture

```
src/
├── index.ts              # Entry point, registers all tools
├── types.ts              # TypeScript interfaces
├── constants.ts          # Shared constants
├── services/
│   ├── auth.ts           # OAuth2 token management
│   └── api-client.ts     # Authenticated HTTP client
├── utils/
│   ├── error-handler.ts  # Error → MCP response
│   ├── app-resolver.ts   # App name → ID resolution
│   └── formatting.ts     # Response formatting
└── tools/                # One file per tool domain
    ├── applications.ts
    ├── health-rules.ts        # CRUD + enable/disable
    ├── health-violations.ts
    ├── anomalies.ts
    ├── business-transactions.ts
    ├── bt-performance.ts
    ├── service-endpoints.ts
    ├── tiers-nodes.ts
    ├── backends.ts
    ├── snapshots.ts
    ├── errors.ts
    ├── metrics.ts             # browse + query with rollup
    ├── dashboards.ts          # full CRUD + auto-build + HealthListWidget scoping
    └── root-cause.ts
```

## Development

```bash
# Run in dev mode (auto-reload)
npm run dev

# Build TypeScript
npm run build

# Run built version
npm start
```

## Authentication

The server supports two authentication modes:

1. **OAuth2 Client Credentials** (recommended): Set `APPD_CLIENT_NAME`, `APPD_CLIENT_SECRET`, and optionally `APPD_ACCOUNT_NAME`. The server acquires and caches tokens automatically.

2. **API Key**: Set only `APPD_CLIENT_NAME` (as the API key). No secret needed.

## License

ISC
