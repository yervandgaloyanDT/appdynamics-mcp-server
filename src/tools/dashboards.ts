/**
 * Dashboard tools: list, get, create, update, clone, delete, export, import, auto-build.
 * Full CRUD for AppDynamics custom dashboards.
 *
 * Two widget format systems:
 *   - Export format: used by auto-build/import/save-file
 *       widgetType: "GraphWidget", metrics in dataSeriesTemplates
 *       Import via POST /controller/CustomDashboardImportExportServlet
 *   - RESTUI format: used by create/update/add-widget
 *       type: "TIMESERIES_GRAPH", metrics in widgetsMetricMatchCriterias
 *       Via POST /controller/restui/dashboards/createDashboard|updateDashboard
 *
 *   Colors are integers (e.g. 16777215 = white), not hex strings.
 *   Canvas type: CANVAS_TYPE_GRID with grid-unit positioning.
 */

import { writeFile } from "fs/promises";
import { resolve, isAbsolute, normalize } from "path";
import { randomUUID } from "crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { appdGet, appdGetRaw, appdPost, appdPostFormData } from "../services/api-client.js";
import { handleError, textResponse } from "../utils/error-handler.js";
import { truncateIfNeeded } from "../utils/formatting.js";
import type { BusinessTransaction, Dashboard, DashboardSummary, HealthRule, Tier } from "../types.js";
import { resolveAppId, resolveAppName } from "../utils/app-resolver.js";

// ── Color Helpers ─────────────────────────────────────────────────────────────

/** Convert hex color string (#RRGGBB) to integer, or pass through if already a number. */
function colorToInt(color: string | number | undefined, fallback: number): number {
  if (color === undefined) return fallback;
  if (typeof color === "number") return color;
  const hex = color.replace(/^#/, "");
  const parsed = parseInt(hex, 16);
  return isNaN(parsed) ? fallback : parsed;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const COLOR_WHITE = 16777215; // #FFFFFF
const COLOR_LIGHT_GRAY = 15856629; // #F1F1F5
const COLOR_DARK = 1646891; // #19222B
const COLOR_BORDER = 14408667; // #DBDBDB

// ── Schemas ───────────────────────────────────────────────────────────────────

const ListSchema = {
  nameFilter: z
    .string()
    .optional()
    .describe("Optional: filter dashboards by name (case-insensitive partial match)."),
};

const GetSchema = {
  dashboardId: z.number().int().describe("The numeric ID of the dashboard."),
};

const DeleteSchema = {
  dashboardId: z.number().int().describe("The numeric ID of the dashboard to delete."),
};

const ExportSchema = {
  dashboardId: z.number().int().describe("The numeric ID of the dashboard to export."),
};

const CloneSchema = {
  dashboardId: z.number().int().describe("The ID of the source dashboard to clone."),
  newName: z.string().min(1).describe("Name for the cloned dashboard."),
};

const WidgetSchema = z.object({
  type: z
    .string()
    .describe(
      "Widget type. Use: 'TIMESERIES_GRAPH' (time-series chart), 'METRIC_VALUE' (single number), 'HEALTH_LIST' (health status), 'TEXT' (text/title), 'PIE' (pie chart), 'GAUGE' (gauge)."
    ),
  title: z.string().describe("Widget title displayed on the dashboard."),
  height: z.number().int().min(1).describe("Widget height in grid units (typical: 2-4)."),
  width: z.number().int().min(1).describe("Widget width in grid units (max 12 for full row)."),
  x: z.number().int().min(0).describe("X position in grid units (0-11)."),
  y: z.number().int().min(0).describe("Y position in grid units."),
  applicationId: z
    .number()
    .int()
    .optional()
    .describe("Application ID to source metrics from."),
  metricPath: z
    .string()
    .optional()
    .describe(
      "Metric path for metric-based widgets. Use appd_browse_metric_tree to find paths."
    ),
  entityType: z
    .string()
    .optional()
    .describe("Entity type: 'APPLICATION', 'APPLICATION_COMPONENT' (tier), 'APPLICATION_COMPONENT_NODE' (node), 'POLICY' (health rules)."),
  text: z
    .string()
    .optional()
    .describe("Text content for TEXT widget type."),
  description: z.string().optional().describe("Widget description."),
  applicationName: z
    .string()
    .optional()
    .describe("Application name (required for export-format files to embed correct metric paths)."),
  adqlQuery: z
    .string()
    .max(2000, "ADQL query must be 2000 characters or fewer")
    .optional()
    .describe("ADQL query string for ANALYTICS widget type (max 2000 chars)."),
  healthRuleIds: z
    .array(z.number().int())
    .optional()
    .describe(
      "For HEALTH_LIST widgets: numeric IDs of specific health rules to display. " +
      "Each widget shows only the listed rules. Omit to show all rules for the application. " +
      "Use appd_get_health_rules to look up rule IDs."
    ),
});

const CreateSchema = {
  name: z.string().min(1).describe("Dashboard name."),
  description: z.string().optional().describe("Dashboard description."),
  height: z
    .number()
    .int()
    .min(100)
    .optional()
    .describe("Dashboard canvas height in pixels. Default: 768."),
  width: z
    .number()
    .int()
    .min(100)
    .optional()
    .describe("Dashboard canvas width in pixels. Default: 1024."),
  widgets: z
    .array(WidgetSchema)
    .optional()
    .describe("Array of widgets to place on the dashboard. Can be empty to create a blank dashboard, then add widgets later with appd_add_widget_to_dashboard."),
  template: z
    .boolean()
    .optional()
    .describe("If true, create as a template dashboard."),
};

const UpdateSchema = {
  dashboardId: z.number().int().describe("The ID of the dashboard to update."),
  name: z.string().optional().describe("New dashboard name."),
  description: z.string().optional().describe("New dashboard description."),
  height: z.number().int().min(100).optional().describe("New canvas height."),
  width: z.number().int().min(100).optional().describe("New canvas width."),
  widgets: z
    .array(WidgetSchema)
    .optional()
    .describe("Complete set of widgets. NOTE: This replaces ALL existing widgets."),
};

const AddWidgetSchema = {
  dashboardId: z.number().int().describe("The ID of the dashboard to add a widget to."),
  widget: WidgetSchema.describe("The widget to add to the dashboard."),
};

// ── Registration ──────────────────────────────────────────────────────────────

export function registerDashboardTools(server: McpServer): void {
  // ── List Dashboards ─────────────────────────────────────────────────────────

  server.registerTool(
    "appd_get_dashboards",
    {
      title: "List Dashboards",
      description: `List all custom dashboards in AppDynamics.

Returns dashboard summaries including id, name, creator, and timestamps.
Use nameFilter to search for specific dashboards.

Args:
  - nameFilter (string, optional): Filter by dashboard name

Returns: Array of dashboard summaries.`,
      inputSchema: ListSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ nameFilter }) => {
      try {
        const dashboards = await appdGetRaw<DashboardSummary[]>(
          "/controller/restui/dashboards/getAllDashboardsByType/false"
        );

        let filtered = Array.isArray(dashboards) ? dashboards : [];

        if (nameFilter) {
          const search = nameFilter.toLowerCase();
          filtered = filtered.filter((d) =>
            d.name.toLowerCase().includes(search)
          );
        }

        const summary = filtered.map((d) => ({
          id: d.id,
          name: d.name,
          description: d.description ?? "",
          createdBy: d.createdBy ?? "",
          modifiedOn: d.modifiedOn,
        }));

        return textResponse(truncateIfNeeded(summary));
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // ── Get Dashboard Details ───────────────────────────────────────────────────

  server.registerTool(
    "appd_get_dashboard",
    {
      title: "Get Dashboard Details",
      description: `Get the full definition of a specific dashboard, including all widgets and their configurations.

This reveals what metrics and entities the dashboard monitors — useful for understanding what a team cares about, or for cloning/modifying dashboards.

Args:
  - dashboardId (number): Dashboard ID (from appd_get_dashboards)

Returns: Complete dashboard object with widgets, layout, and data source configuration.`,
      inputSchema: GetSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ dashboardId }) => {
      try {
        const dashboard = await appdGetRaw<Dashboard>(
          `/controller/restui/dashboards/dashboardIfUpdated/${dashboardId}/-1`
        );
        return textResponse(truncateIfNeeded(dashboard));
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // ── Create Dashboard ────────────────────────────────────────────────────────

  server.registerTool(
    "appd_create_dashboard",
    {
      title: "Create Dashboard",
      description: `Create a new custom dashboard in AppDynamics.

You can create a blank dashboard and add widgets later using appd_add_widget_to_dashboard, or provide widgets upfront.

Widget types (use exact names):
  - "TIMESERIES_GRAPH": Time-series line/area chart (needs applicationId + metricPath)
  - "METRIC_VALUE": Single metric number display (needs applicationId + metricPath)
  - "HEALTH_LIST": Health rule status list (needs applicationId, entityType like 'POLICY')
  - "TEXT": Static text label or title (needs text)
  - "PIE": Pie chart (needs applicationId + metricPath)
  - "GAUGE": Gauge display (needs applicationId + metricPath)

Grid layout: width max is 12 (full row). Height is in grid units (2-4 typical).
Use appd_browse_metric_tree to discover metric paths for widgets.

Args:
  - name (string): Dashboard name
  - description (string, optional): Description
  - height/width (number, optional): Canvas size (default: 768x1024)
  - widgets (array, optional): Widgets to place on the dashboard
  - template (boolean, optional): Create as template

Returns: The created dashboard object with its new ID.`,
      inputSchema: CreateSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ name, description, height, width, widgets, template }) => {
      try {
        // Deduplicate app IDs that need name resolution
        const idsToResolve = [...new Set(
          (widgets ?? [])
            .filter(w => w.applicationId !== undefined && !w.applicationName)
            .map(w => w.applicationId!)
        )];
        const idToName = new Map<number, string>();
        await Promise.all(
          idsToResolve.map(async (id) => {
            idToName.set(id, await resolveAppName(id));
          })
        );

        // Apply resolved names to widgets that need it
        const resolvedWidgets: WidgetInput[] = (widgets ?? []).map(w => {
          if (w.applicationId !== undefined && !w.applicationName) {
            return { ...w, applicationName: idToName.get(w.applicationId) ?? String(w.applicationId) };
          }
          return w;
        });

        // Build export-format payload and import via servlet
        const exportWidgets = resolvedWidgets.map((w, i) => buildExportWidgetPayload(w, i));
        const exportPayload = {
          ...buildExportDashboardEnvelope(name, description ?? null, height ?? 768, width ?? 1024, exportWidgets),
          ...(template ? { template: true } : {}),
        };

        const newId = await importViaServlet(exportPayload, name);

        // Bind metric criteria and health rule scoping via RESTUI two-step approach.
        if (newId != null) {
          try {
            await bindMetricWidgets(
              newId,
              resolvedWidgets.filter(
                (w) => w.metricPath !== undefined && w.applicationId !== undefined,
              ),
            );
          } catch {
            // Non-fatal: dashboard exists, widgets may show no data
          }
          try {
            await bindHealthListWidgets(newId);
          } catch {
            // Non-fatal
          }
        }

        return textResponse(
          `Dashboard "${name}" created successfully` +
          (newId != null ? ` (ID: ${newId}).` : `. ID unknown — check appd_get_dashboards.`)
        );
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // ── Update Dashboard ────────────────────────────────────────────────────────

  server.registerTool(
    "appd_update_dashboard",
    {
      title: "Update Dashboard",
      description: `Update an existing dashboard's properties and/or widgets.

IMPORTANT: If you provide widgets, this REPLACES all existing widgets. To add a single widget without losing existing ones, use appd_add_widget_to_dashboard instead.

Args:
  - dashboardId (number): Dashboard ID
  - name (string, optional): New name
  - description (string, optional): New description
  - height/width (number, optional): New canvas size
  - widgets (array, optional): Complete widget set (replaces existing)

Returns: The updated dashboard object.`,
      inputSchema: UpdateSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ dashboardId, name, description, height, width, widgets }) => {
      try {
        const existing = await appdGetRaw<Record<string, unknown>>(
          `/controller/restui/dashboards/dashboardIfUpdated/${dashboardId}/-1`
        );

        // Resolve app names for widgets that need them
        let resolvedWidgets: WidgetInput[] | undefined;
        if (widgets !== undefined) {
          const idsToResolve = [...new Set(
            widgets
              .filter(w => w.applicationId !== undefined && !w.applicationName)
              .map(w => w.applicationId!)
          )];
          const idToName = new Map<number, string>();
          await Promise.all(
            idsToResolve.map(async id => { idToName.set(id, await resolveAppName(id)); })
          );
          resolvedWidgets = widgets.map(w =>
            w.applicationId !== undefined && !w.applicationName
              ? { ...w, applicationName: idToName.get(w.applicationId) ?? String(w.applicationId) }
              : w
          );
        }

        // Step 1: Update dashboard properties + new widgets WITHOUT inline metric criteria.
        // New widgets need server-assigned IDs/GUIDs before criteria can reference them.
        const updated = {
          ...existing,
          ...(name !== undefined && { name }),
          ...(description !== undefined && { description }),
          ...(height !== undefined && { height }),
          ...(width !== undefined && { width }),
          ...(resolvedWidgets !== undefined && {
            widgets: resolvedWidgets.map((w, i) => ({
              ...buildWidgetPayload(w, i),
              id: 0,
              version: 0,
              guid: randomUUID(),
              dashboardId,
              widgetsMetricMatchCriterias: null,
            })),
          }),
        };

        await appdPost<Dashboard>("/controller/restui/dashboards/updateDashboard", updated);

        // Step 2: Bind metric criteria and health rule scoping using server-assigned widget IDs/GUIDs.
        if (resolvedWidgets !== undefined) {
          const metricWidgets = resolvedWidgets.filter(
            w => w.metricPath !== undefined && w.applicationId !== undefined
          );
          if (metricWidgets.length > 0) {
            try {
              await bindMetricWidgets(dashboardId, metricWidgets);
            } catch {
              // Non-fatal: dashboard updated, widgets may show no data
            }
          }
          try {
            await bindHealthListWidgets(dashboardId);
          } catch {
            // Non-fatal
          }
        }

        const result = await appdGetRaw<Dashboard>(
          `/controller/restui/dashboards/dashboardIfUpdated/${dashboardId}/-1`
        );
        return textResponse(JSON.stringify(result, null, 2));
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // ── Add Widget to Dashboard ─────────────────────────────────────────────────

  server.registerTool(
    "appd_add_widget_to_dashboard",
    {
      title: "Add Widget to Dashboard",
      description: `Add a single widget to an existing dashboard without replacing existing widgets.

This fetches the current dashboard, appends the new widget, and saves it.

Widget types (use exact names):
  - "TIMESERIES_GRAPH": Time-series chart (needs applicationId + metricPath)
  - "METRIC_VALUE": Single metric number (needs applicationId + metricPath)
  - "HEALTH_LIST": Health status list (needs applicationId + entityType)
  - "TEXT": Static text label (needs text)

Args:
  - dashboardId (number): Dashboard ID
  - widget: Widget object with type, title, height, width, x, y, and type-specific fields

Returns: The updated dashboard with the new widget added.`,
      inputSchema: AddWidgetSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ dashboardId, widget }) => {
      try {
        const existing = await appdGetRaw<Dashboard>(
          `/controller/restui/dashboards/dashboardIfUpdated/${dashboardId}/-1`
        );

        const existingWidgets = existing.widgets ?? [];
        const newWidgetIndex = existingWidgets.length;

        // Step 1: Add widget WITHOUT metric criteria.
        // The RESTUI API crashes (500) when adding a new widget (id=0) with metric criteria,
        // because the criteria must reference the server-assigned widgetId and widgetGuid.
        const widgetGuid = randomUUID();
        const basePayload = {
          ...buildWidgetPayload(widget, newWidgetIndex),
          id: 0,
          version: 0,
          guid: widgetGuid,
          dashboardId,
          widgetsMetricMatchCriterias: null,
        };

        const step1 = await appdPost<Dashboard>(
          "/controller/restui/dashboards/updateDashboard",
          { ...existing, widgets: [...existingWidgets, basePayload] }
        );

        // Step 2: If metric widget, bind criteria using the server-assigned id/guid.
        if (widget.metricPath && widget.applicationId) {
          type W = Record<string, unknown>;
          const addedWidget = (step1.widgets as W[] | undefined)?.find(
            (w) => (w["guid"] as string) === widgetGuid || w["title"] === widget.title
          );
          if (addedWidget?.["id"] && addedWidget?.["guid"]) {
            const criteria = buildResuiMetricSeries(
              widget,
              addedWidget["id"] as number,
              addedWidget["guid"] as string,
              dashboardId,
            );
            if (criteria) {
              const step2Dash = await appdGetRaw<Dashboard>(
                `/controller/restui/dashboards/dashboardIfUpdated/${dashboardId}/-1`
              );
              const step2Widgets = ((step2Dash.widgets as W[]) ?? []).map((w) =>
                w["id"] === addedWidget["id"]
                  ? { ...w, widgetsMetricMatchCriterias: criteria }
                  : w
              );
              const step2 = await appdPost<Dashboard>(
                "/controller/restui/dashboards/updateDashboard",
                { ...step2Dash, widgets: step2Widgets }
              );
              return textResponse(JSON.stringify(step2, null, 2));
            }
          }
        }

        return textResponse(JSON.stringify(step1, null, 2));
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // ── Clone Dashboard ─────────────────────────────────────────────────────────

  server.registerTool(
    "appd_clone_dashboard",
    {
      title: "Clone Dashboard",
      description: `Clone an existing dashboard with a new name.

Creates an exact copy of the source dashboard (including all widgets) with the specified new name.

Args:
  - dashboardId (number): Source dashboard ID to clone
  - newName (string): Name for the cloned dashboard

Returns: The newly created dashboard with its new ID.`,
      inputSchema: CloneSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ dashboardId, newName }) => {
      try {
        const source = await appdGetRaw<Dashboard>(
          `/controller/restui/dashboards/dashboardIfUpdated/${dashboardId}/-1`
        );

        const { id: _id, ...cloneData } = source;

        // Zero out widget IDs/GUIDs so AppDynamics creates fresh widgets
        // (keeping source widget IDs causes conflicts when createDashboard runs)
        type CW = Record<string, unknown>;
        type CC = Record<string, unknown>;
        const srcWidgets = (cloneData as Record<string, unknown>)["widgets"] as CW[] | undefined;
        const clonePayload = {
          ...cloneData,
          name: newName,
          widgets: srcWidgets?.map(w => ({
            ...w,
            id: 0,
            version: 0,
            guid: randomUUID(),
            dashboardId: 0,
            widgetsMetricMatchCriterias: (w["widgetsMetricMatchCriterias"] as CC[] | null | undefined)
              ?.map(c => ({ ...c, id: 0, version: 0, widgetId: 0, widgetGuid: null, dashboardId: 0 }))
              ?? null,
          })) ?? [],
        };

        const created = await appdPost<Dashboard>(
          "/controller/restui/dashboards/createDashboard",
          clonePayload
        );

        return textResponse(JSON.stringify(created, null, 2));
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // ── Delete Dashboard ────────────────────────────────────────────────────────

  server.registerTool(
    "appd_delete_dashboard",
    {
      title: "Delete Dashboard",
      description: `Delete a custom dashboard. This action is PERMANENT and cannot be undone.

Consider using appd_export_dashboard first to create a backup.

Args:
  - dashboardId (number): Dashboard ID to delete

Returns: Confirmation of deletion.`,
      inputSchema: DeleteSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ dashboardId }) => {
      try {
        await appdPost(
          `/controller/restui/dashboards/deleteDashboards`,
          [dashboardId]
        );
        return textResponse(
          `Dashboard ${dashboardId} deleted successfully.`
        );
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // ── Auto-Build Dashboard ────────────────────────────────────────────────────

  server.registerTool(
    "appd_auto_build_dashboard",
    {
      title: "Auto-Build Dashboard",
      description: `Automatically build a complete monitoring dashboard for an application.

Discovers the application's tiers, business transactions, and health rules, then creates a fully populated multi-section dashboard in AppDynamics.

Focus modes:
  - "comprehensive" (default): Overview + business transactions + infrastructure + health
  - "performance": Overview + business transactions
  - "infrastructure": Overview + tier-level graphs
  - "health": Overview + health status

Args:
  - applicationName (string): Application name or numeric ID
  - dashboardName (string, optional): Dashboard name. Defaults to "{AppName} - Auto Dashboard"
  - focus (string, optional): comprehensive | performance | infrastructure | health
  - timeRangeMinutes (number, optional): Time window in minutes. Default: 60

Returns: The created dashboard name and ID.`,
      inputSchema: {
        applicationName: z.string().describe("Application name or numeric ID."),
        dashboardName: z
          .string()
          .optional()
          .describe('Dashboard name. Defaults to "{AppName} - Auto Dashboard".'),
        focus: z
          .enum(["comprehensive", "performance", "infrastructure", "health"])
          .optional()
          .describe(
            'Dashboard focus: "comprehensive" (default), "performance", "infrastructure", or "health".'
          ),
        timeRangeMinutes: z
          .number()
          .int()
          .min(5)
          .optional()
          .describe("Time window in minutes for metric graphs. Default: 60."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ applicationName, dashboardName, focus = "comprehensive", timeRangeMinutes = 60 }) => {
      try {
        const appId = await resolveAppId(applicationName);
        const appName = await resolveAppName(appId);

        const needsBTs = focus === "comprehensive" || focus === "performance";
        const needsTiers = focus === "comprehensive" || focus === "infrastructure";
        const needsHealth = focus === "comprehensive" || focus === "health";

        // Parallel data fetch — only request what the focus mode needs
        const [tiers, bts, healthRules] = await Promise.all([
          needsTiers
            ? appdGet<Tier[]>(`/controller/rest/applications/${appId}/tiers`)
            : Promise.resolve([] as Tier[]),
          needsBTs
            ? appdGet<BusinessTransaction[]>(
                `/controller/rest/applications/${appId}/business-transactions`
              )
            : Promise.resolve([] as BusinessTransaction[]),
          needsHealth
            ? appdGet<HealthRule[]>(
                `/controller/rest/applications/${appId}/policy/health-rules`
              ).catch(() => [] as HealthRule[])
            : Promise.resolve([] as HealthRule[]),
        ]);

        const topTiers = tiers.slice(0, 3);
        const topBTs = bts.slice(0, 5);
        const dashName = dashboardName ?? `${appName} - Auto Dashboard`;

        // ── Compose widget list ──────────────────────────────────────────────
        const widgets: WidgetInput[] = [];
        let y = 0;

        function push(w: WidgetInput): void {
          widgets.push(w);
        }

        // ── Section: App Overview — title banner ─────────────────────────────
        push({
          type: "TEXT",
          title: "Dashboard Title",
          text: `── ${appName} Performance Dashboard ──`,
          width: 12,
          height: 1,
          x: 0,
          y,
        });
        y += 1;

        // ── Section: App Overview — time-series graphs (3 columns) ───────────
        const overviewGraphs = [
          {
            title: "Response Time (ms)",
            metric: "Overall Application Performance|Average Response Time (ms)",
          },
          {
            title: "Errors per Minute",
            metric: "Overall Application Performance|Errors per Minute",
          },
          {
            title: "Calls per Minute",
            metric: "Overall Application Performance|Calls per Minute",
          },
        ];
        overviewGraphs.forEach((g, i) => {
          push({
            type: "TIMESERIES_GRAPH",
            title: g.title,
            metricPath: g.metric,
            applicationId: appId,
            applicationName: appName,
            width: 4,
            height: 3,
            x: i * 4,
            y,
          });
        });
        y += 3;

        // ── Section: App Overview — metric value tiles ───────────────────────
        const metricValues = [
          {
            title: "Avg Response Time",
            metric: "Overall Application Performance|Average Response Time (ms)",
          },
          {
            title: "Error Rate",
            metric: "Overall Application Performance|Errors per Minute",
          },
          {
            title: "Throughput",
            metric: "Overall Application Performance|Calls per Minute",
          },
          {
            title: "Stall Count",
            metric: "Overall Application Performance|Stall Count",
          },
        ];
        metricValues.forEach((v, i) => {
          push({
            type: "METRIC_VALUE",
            title: v.title,
            metricPath: v.metric,
            applicationId: appId,
            applicationName: appName,
            width: 3,
            height: 2,
            x: i * 3,
            y,
          });
        });
        y += 2;

        // ── Section: Business Transactions ───────────────────────────────────
        if (needsBTs && topBTs.length > 0) {
          push({
            type: "TEXT",
            title: "BT Section Header",
            text: "── Business Transactions ──",
            width: 12,
            height: 1,
            x: 0,
            y,
          });
          y += 1;

          const n = topBTs.length;
          const baseW = Math.floor(12 / n);
          const extra = 12 - baseW * n;
          let btX = 0;
          topBTs.forEach((bt, i) => {
            const w = baseW + (i < extra ? 1 : 0);
            push({
              type: "METRIC_VALUE",
              title: bt.name,
              metricPath: `Business Transaction Performance|Business Transactions|${bt.tierName}|${bt.name}|Average Response Time (ms)`,
              applicationId: appId,
              applicationName: appName,
              btIds: [bt.id],
              width: w,
              height: 2,
              x: btX,
              y,
            });
            btX += w;
          });
          y += 2;
        }

        // ── Section: Infrastructure ──────────────────────────────────────────
        if (needsTiers && topTiers.length > 0) {
          push({
            type: "TEXT",
            title: "Infrastructure Section Header",
            text: "── Infrastructure ──",
            width: 12,
            height: 1,
            x: 0,
            y,
          });
          y += 1;

          const n = topTiers.length;
          const baseW = Math.floor(12 / n);
          const extra = 12 - baseW * n;
          topTiers.forEach((tier, i) => {
            push({
              type: "TIMESERIES_GRAPH",
              title: `${tier.name} - Response Time`,
              metricPath: `Overall Application Performance|${tier.name}|Average Response Time (ms)`,
              applicationId: appId,
              applicationName: appName,
              width: i === n - 1 ? baseW + extra : baseW,
              height: 3,
              x: i * baseW,
              y,
            });
          });
          y += 3;
        }

        // ── Section: Health Status ───────────────────────────────────────────
        if (needsHealth) {
          push({
            type: "TEXT",
            title: "Health Section Header",
            text: "── Health Status ──",
            width: 12,
            height: 1,
            x: 0,
            y,
          });
          y += 1;

          push({
            type: "HEALTH_LIST",
            title: "Health Rules Status",
            applicationId: appId,
            applicationName: appName,
            entityType: "APPLICATION",
            width: 12,
            height: 4,
            x: 0,
            y,
          });
          y += 4;
        }

        // ── Build export-format payload and POST to the import servlet ─────────
        const canvasHeight = Math.max(768, y * 60 + 60);

        // Build widgets in export format (same format as appd_save_dashboard_file)
        const exportWidgets = widgets.map((w, i) => buildExportWidgetPayload(w, i));

        // Wrap in export envelope then override timeRange with user's preference
        const exportPayload = {
          ...buildExportDashboardEnvelope(
            dashName,
            `Auto-generated ${focus} dashboard for ${appName}`,
            canvasHeight,
            1024,
            exportWidgets
          ),
          minutesBeforeAnchorTime: timeRangeMinutes,
        };

        const newId = await importViaServlet(exportPayload, dashName);

        // Bind metric criteria and health rule scoping via RESTUI two-step approach.
        // The import servlet creates widgets (assigning ids/guids) but drops metric bindings.
        // We re-fetch and bind BT_AFFECTED_EMC criteria to each metric widget.
        if (newId != null) {
          try {
            await bindMetricWidgets(
              newId,
              widgets.filter(
                (w) => w.metricPath !== undefined && w.applicationId !== undefined,
              ),
            );
          } catch {
            // Non-fatal: dashboard exists, widgets may show no data
          }
          try {
            await bindHealthListWidgets(newId);
          } catch {
            // Non-fatal
          }
        }

        return textResponse(
          `Dashboard "${dashName}" created successfully` +
          (newId != null ? ` (ID: ${newId}).` : `. ID unknown — check appd_get_dashboards.`)
        );
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // ── Export Dashboard ────────────────────────────────────────────────────────

  server.registerTool(
    "appd_export_dashboard",
    {
      title: "Export Dashboard JSON",
      description: `Export a dashboard as a portable JSON definition.

The exported JSON can be used to recreate the dashboard in another controller or back it up.

Args:
  - dashboardId (number): Dashboard ID to export

Returns: Complete dashboard JSON definition suitable for import.`,
      inputSchema: ExportSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ dashboardId }) => {
      try {
        const dashboard = await appdGetRaw<Dashboard>(
          `/controller/CustomDashboardImportExportServlet`,
          { dashboardId }
        );
        return textResponse(JSON.stringify(dashboard, null, 2));
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // ── Import Dashboard ────────────────────────────────────────────────────────

  server.registerTool(
    "appd_import_dashboard",
    {
      title: "Import Dashboard from JSON",
      description: `Create a new dashboard from a JSON definition string.

Accepts the JSON output of appd_export_dashboard (or any saved dashboard JSON file) and creates a new dashboard from it. The original ID is always discarded — AppDynamics assigns a fresh one.

Typical workflow:
  1. appd_export_dashboard → save JSON to a file
  2. Edit the file if needed (rename, adjust metrics, etc.)
  3. appd_import_dashboard with the file contents → new dashboard created

Args:
  - dashboardJson (string): Full dashboard JSON (paste contents of an exported file)
  - dashboardName (string, optional): Override the name from the JSON

Returns: The newly created dashboard with its new ID.`,
      inputSchema: {
        dashboardJson: z
          .string()
          .min(2)
          .describe(
            "Full dashboard JSON definition — paste the contents of an exported dashboard file."
          ),
        dashboardName: z
          .string()
          .optional()
          .describe("Override the dashboard name from the JSON."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ dashboardJson, dashboardName }) => {
      try {
        // Parse and validate
        let raw: unknown;
        try {
          raw = JSON.parse(dashboardJson);
        } catch {
          return handleError(
            new Error(
              "Invalid JSON: could not parse dashboardJson. Make sure you pasted the complete JSON content."
            )
          );
        }

        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
          return handleError(
            new Error(
              "dashboardJson must be a JSON object. Got: " +
                (Array.isArray(raw) ? "array" : typeof raw)
            )
          );
        }

        const parsed = raw as Record<string, unknown>;

        // Resolve name
        const resolvedName =
          dashboardName ??
          (typeof parsed.name === "string" ? parsed.name : null);
        if (!resolvedName) {
          return handleError(
            new Error(
              "Dashboard JSON has no 'name' field. Use the dashboardName parameter to set one."
            )
          );
        }

        // Pass the full JSON directly to the import servlet.
        // Remove any stale id so AppDynamics creates fresh instead of overwriting.
        const finalPayload: Record<string, unknown> = { ...parsed };
        if (dashboardName) finalPayload["name"] = dashboardName;
        delete finalPayload["id"];

        const newId = await importViaServlet(finalPayload, resolvedName);

        // Fix HEALTH_LIST entityIds after import (servlet leaves them empty)
        if (newId != null) {
          try {
            await bindHealthListWidgets(newId);
          } catch {
            // Non-fatal
          }
        }

        return textResponse(
          `Dashboard "${resolvedName}" imported successfully` +
          (newId != null ? ` (ID: ${newId}).` : `. ID unknown — check appd_get_dashboards.`)
        );
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // ── Save Dashboard Definition to File ──────────────────────────────────────

  server.registerTool(
    "appd_save_dashboard_file",
    {
      title: "Save Dashboard Definition to File",
      description: `Build a complete AppDynamics dashboard JSON definition and save it to a local file — without creating anything in AppDynamics yet.

The saved file can be:
  - Inspected or edited before importing
  - Version-controlled alongside your code
  - Imported with appd_import_dashboard at any time

The file format is identical to appd_export_dashboard output and is directly importable.

Widget types (use exact names):
  - "TIMESERIES_GRAPH": Time-series chart (needs applicationId + metricPath)
  - "METRIC_VALUE": Single metric number (needs applicationId + metricPath)
  - "HEALTH_LIST": Health status list (needs applicationId + entityType)
  - "TEXT": Static label or section heading (needs text)
  - "PIE": Pie chart (needs applicationId + metricPath)
  - "GAUGE": Gauge (needs applicationId + metricPath)

Grid layout: width max is 12 (full row). Height is in grid units (1–4 typical).
Use appd_browse_metric_tree to discover metric paths.

Args:
  - name (string): Dashboard name
  - filePath (string, optional): Where to write the file. Default: ./dashboard-{name}.json
  - description (string, optional): Dashboard description
  - height/width (number, optional): Canvas size in pixels (default: 768×1024)
  - widgets (array, optional): Widget definitions

Returns: Absolute path of the saved file and a widget summary.`,
      inputSchema: {
        name: z.string().min(1).describe("Dashboard name."),
        filePath: z
          .string()
          .optional()
          .describe(
            "File path to save the JSON. Default: ./dashboard-{slugified-name}.json"
          ),
        description: z.string().optional().describe("Dashboard description."),
        height: z
          .number()
          .int()
          .min(100)
          .optional()
          .describe("Canvas height in pixels. Default: 768."),
        width: z
          .number()
          .int()
          .min(100)
          .optional()
          .describe("Canvas width in pixels. Default: 1024."),
        widgets: z
          .array(WidgetSchema)
          .optional()
          .describe("Widgets to include. Same format as appd_create_dashboard."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ name, filePath, description, height, width, widgets }) => {
      try {
        const builtWidgets = (widgets ?? []).map((w, i) =>
          buildExportWidgetPayload(w, i)
        );

        const dashboardPayload = buildExportDashboardEnvelope(
          name,
          description ?? null,
          height ?? 768,
          width ?? 1024,
          builtWidgets,
        );

        const json = JSON.stringify(dashboardPayload, null, 2);

        const slug = name.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();

        let outputPath: string;
        if (filePath) {
          // Reject paths containing traversal sequences
          const normalized = normalize(filePath);
          if (normalized.includes("..") || (!isAbsolute(normalized) && normalized.startsWith("/"))) {
            return textResponse("Error: filePath must not contain path traversal sequences ('..').");
          }
          outputPath = resolve(normalized);
        } else {
          outputPath = resolve(`./dashboard-${slug}.json`);
        }

        await writeFile(outputPath, json, "utf-8");

        const widgetSummary = builtWidgets
          .map((w) => `  - [${String(w.widgetType)}] ${String(w.title)}`)
          .join("\n");

        return textResponse(
          `Dashboard definition saved to:\n${outputPath}\n\n` +
            `Name: ${name}\n` +
            `Widgets: ${builtWidgets.length}\n` +
            `Canvas: ${width ?? 1024} × ${height ?? 768} px\n\n` +
            (builtWidgets.length > 0
              ? `Widgets included:\n${widgetSummary}\n\n`
              : "") +
            `To create in AppDynamics:\n` +
            `  appd_import_dashboard with the contents of this file`
        );
      } catch (error) {
        return handleError(error);
      }
    }
  );
}

// ── Widget Builder ────────────────────────────────────────────────────────────

interface WidgetInput {
  type: string;
  title: string;
  height: number;
  width: number;
  x: number;
  y: number;
  applicationId?: number;
  applicationName?: string;
  metricPath?: string;
  entityType?: string;
  text?: string;
  label?: string;
  description?: string;
  adqlQuery?: string;
  btIds?: number[];
  healthRuleIds?: number[];
}

// ── Export Format Builders ────────────────────────────────────────────────────
// These produce the same JSON structure that AppDynamics generates when you
// export a dashboard via the UI — suitable for save_dashboard_file and import.

const EXPORT_TYPE_MAP: Record<string, string> = {
  TIMESERIES_GRAPH: "GraphWidget",
  METRIC_VALUE: "MetricLabelWidget",
  HEALTH_LIST: "HealthListWidget",
  TEXT: "TextWidget",
  PIE: "PieWidget",
  GAUGE: "GaugeWidget",
  ANALYTICS: "AnalyticsWidget",
  // pass-through if already in export class-name form
  GraphWidget: "GraphWidget",
  MetricLabelWidget: "MetricLabelWidget",
  HealthListWidget: "HealthListWidget",
  TextWidget: "TextWidget",
  PieWidget: "PieWidget",
  GaugeWidget: "GaugeWidget",
  AnalyticsWidget: "AnalyticsWidget",
};

/**
 * Build a widget in the AppDynamics export/import JSON format.
 * Matches what AppDynamics produces when you click Export Dashboard in the UI.
 * Key differences from the RESTUI format:
 *   - widgetType uses class names (GaugeWidget, AdvancedGraph, etc.)
 *   - metrics live in dataSeriesTemplates[].metricMatchCriteriaTemplate
 *   - inputMetricPath uses Root||Applications||AppName|| prefix
 *   - backgroundColorsStr is a comma-separated string, backgroundColors is null
 */
function buildExportWidgetPayload(w: WidgetInput, index: number): Record<string, unknown> {
  const widgetType = EXPORT_TYPE_MAP[w.type] ?? w.type;

  // Base fields common to all widget types (from real export example)
  const base: Record<string, unknown> = {
    widgetType,
    title: w.title,
    height: w.height,
    width: w.width,
    minHeight: 0,
    minWidth: 0,
    x: w.x,
    y: w.y,
    label: null,
    description: w.description ?? null,
    drillDownUrl: null,
    openUrlInCurrentTab: false,
    useMetricBrowserAsDrillDown: widgetType !== "TextWidget" && widgetType !== "AnalyticsWidget",
    drillDownActionType: null,
    backgroundColor: COLOR_WHITE,
    backgroundColors: null,
    backgroundColorsStr: `${COLOR_WHITE},${COLOR_WHITE}`,
    color: COLOR_DARK,
    fontSize: 12,
    useAutomaticFontSize: false,
    borderEnabled: false,
    borderThickness: 0,
    borderColor: COLOR_BORDER,
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
  };

  // ── TextWidget ────────────────────────────────────────────────────────────
  if (widgetType === "TextWidget") {
    base.useMetricBrowserAsDrillDown = false;
    base.text = w.text ?? "";
    return base;
  }

  // ── AnalyticsWidget ───────────────────────────────────────────────────────
  if (widgetType === "AnalyticsWidget") {
    base.useMetricBrowserAsDrillDown = false;
    base.showValues = false;
    base.formatNumber = true;
    base.numDecimals = 2;
    base.removeZeros = true;
    base.borderColor = 0;
    base.color = 3342336;           // AppDynamics analytics blue
    base.backgroundColorsStr = null;
    base.adqlQueryList = w.adqlQuery ? [w.adqlQuery] : [];
    base.analyticsWidgetType = "TABLE";
    base.searchMode = "ADVANCED";
    base.isStackingEnabled = false;
    base.legendsLayout = null;
    base.maxAllowedYAxisFields = 10;
    base.maxAllowedXAxisFields = 10;
    base.min = null;
    base.interval = null;
    base.max = null;
    base.intervalType = null;
    base.maxType = null;
    base.minType = null;
    base.showMinExtremes = false;
    base.showMaxExtremes = false;
    base.displayPercentileMarkers = false;
    base.percentileValue1 = null;
    base.percentileValue2 = null;
    base.percentileValue3 = null;
    base.percentileValue4 = null;
    base.isShowLogYAxis = false;
    base.resolution = null;
    base.dataFetchSize = null;
    base.percentileLine = null;
    base.timeRangeInterval = null;
    base.pollingInterval = null;
    base.unit = 0;
    base.isRawQuery = true;
    base.viewState = null;
    base.gridState = null;
    base.slmConfigId = null;
    base.bjId = null;
    base.showInverse = false;
    base.showHealth = false;
    base.align = "center";
    base.compareToOption = null;
    base.trailingPeriod = null;
    base.trailingPeriodUnit = null;
    base.isIncreaseGood = null;
    base.numberFormatOption = null;
    base.showUnivariateLabel = true;
    return base;
  }

  // ── HealthListWidget ──────────────────────────────────────────────────────
  if (widgetType === "HealthListWidget") {
    const appName = w.applicationName ?? String(w.applicationId ?? "");
    // applicationReference scopes the widget to this application
    base.applicationReference = appName ? {
      applicationName: appName,
      entityType: "APPLICATION",
      entityName: appName,
      scopingEntityType: null,
      scopingEntityName: null,
      subtype: null,
      uniqueKey: null,
    } : null;
    // Scoping mechanism discovered from AppD UI:
    //   propertiesMap.selectedEntityIds = health rule ID(s) as comma-separated string
    //   entitySelectionType = null  (NOT "ALL" — null tells AppD to use selectedEntityIds)
    // Without selectedEntityIds the widget shows all rules for the application.
    base.entityType = w.entityType ?? "POLICY";
    base.entitySelectionType = null;
    base.entityReferences = [];
    if (w.healthRuleIds?.length) {
      base.propertiesMap = { selectedEntityIds: w.healthRuleIds.join(",") };
    } else {
      base.propertiesMap = null;
    }
    base.iconSize = 18;
    base.iconPosition = "LEFT";
    base.showSearchBox = false;
    base.showList = true;
    base.showListHeader = false;
    base.showBarPie = true;
    base.showPie = false;
    base.showCurrentHealthStatus = false;
    base.innerRadius = 0;
    base.aggregationType = "RATIO";
    return base;
  }

  // ── Metric-based widgets (GaugeWidget, GraphWidget, MetricLabelWidget, PieWidget) ──
  if (w.metricPath) {
    const appName = w.applicationName ?? String(w.applicationId ?? "");
    // inputMetricPath uses || separators with Root||Applications||AppName|| prefix.
    const inputMetricPath =
      `Root||Applications||${appName}||` + w.metricPath.replace(/\|/g, "||");

    // Determine metricType and entityType based on the metric path prefix.
    // AppDynamics export format only accepts specific metricType enum values.
    const isBT = w.metricPath.startsWith("Business Transaction Performance");
    const metricType = isBT ? "BUSINESS_TRANSACTION" : "OVERALL_APPLICATION";
    const entityType = isBT ? "BUSINESS_TRANSACTION" : "APPLICATION";
    const evaluationScopeType = isBT ? "TIER_AVERAGE" : null;

    base.dataSeriesTemplates = [
      {
        seriesType: "LINE",
        metricType,
        showRawMetricName: false,
        colorPalette: null,
        name: `Series ${index}`,
        metricMatchCriteriaTemplate: {
          entityMatchCriteria: {
            matchCriteriaType: "SpecificEntities",
            entityType,
            agentTypes: null,
            entityNames: [],
            summary: false,
          },
          metricExpressionTemplate: {
            metricExpressionType: "Logical",
            functionType: "VALUE",
            displayName: null,
            inputMetricText: false,
            inputMetricPath,
            relativeMetricPath: w.metricPath,
          },
          rollupMetricData: false,
          expressionString: "",
          useActiveBaseline: false,
          sortResultsAscending: false,
          maxResults: 20,
          evaluationScopeType,
          baselineName: null,
          applicationName: appName,
          metricDisplayNameStyle: "DISPLAY_STYLE_AUTO",
          metricDisplayNameCustomFormat: null,
          includeHistoricalNodes: null,
          includeAbove: null,
          includeBelow: null,
          includeBoth: null,
          includeBand12: null,
          includeBand23: null,
          includeBand34: null,
          includeBand45: null,
          includeShade: null,
        },
        axisPosition: null,
      },
    ];
  }

  // Widget-type-specific extra fields
  if (widgetType === "GaugeWidget") {
    base.showLabels = true;
    base.showPercentValues = null;
    base.useMinMaxValues = true;
    base.minValue = 0;
    base.maxValue = 100;
    base.invertColors = false;
  }

  if (widgetType === "MetricLabelWidget") {
    base.label = w.label ?? "${v}";
    base.text = null;
    base.textAlign = "RIGHT";
    base.margin = 15;
    base.showLabel = false;
    base.showBaseline = false;
    base.useBaselineColor = false;
    base.reverseBaselineColorOrder = false;
  }

  if (widgetType === "GraphWidget") {
    base.showValues = false;
    base.showLegend = true;
    base.legendPosition = "POSITION_BOTTOM";
    base.legendColumnCount = 1;
    base.verticalAxisLabel = null;
    base.hideHorizontalAxis = null;
    base.horizontalAxisLabel = null;
    base.axisType = "LINEAR";
    base.stackMode = null;
    base.multipleYAxis = null;
    base.customVerticalAxisMin = null;
    base.customVerticalAxisMax = null;
    base.showEvents = null;
    base.interpolateDataGaps = false;
    base.showAllTooltips = null;
    base.staticThresholdList = [];
    base.eventFilterTemplate = null;
  }

  return base;
}

/**
 * Wrap widget array in the top-level envelope that AppDynamics uses for
 * exported dashboard JSON files. This is the structure you get from
 * "Export Dashboard" in the AppDynamics UI.
 */
function buildExportDashboardEnvelope(
  name: string,
  description: string | null,
  height: number,
  width: number,
  widgetTemplates: Record<string, unknown>[],
): Record<string, unknown> {
  return {
    schemaVersion: null,
    dashboardFormatVersion: "4.0",
    name,
    description,
    properties: null,
    templateEntityType: "APPLICATION_COMPONENT_NODE",
    associatedEntityTemplates: null,
    timeRangeSpecifierType: "UNKNOWN",
    minutesBeforeAnchorTime: -1,
    startDate: null,
    endDate: null,
    refreshInterval: 120000,
    backgroundColor: COLOR_LIGHT_GRAY,
    color: COLOR_LIGHT_GRAY,
    height,
    width,
    canvasType: "CANVAS_TYPE_GRID",
    layoutType: "",
    widgetTemplates,
    warRoom: false,
    template: false,
  };
}

// ── Import Servlet Helper ─────────────────────────────────────────────────────

/**
 * POST an export-format dashboard JSON to the AppDynamics import servlet.
 * Returns the new dashboard ID (or null if it cannot be determined).
 * Three-tier fallback: direct id field → array response → name-based list lookup.
 */
async function importViaServlet(
  exportJson: Record<string, unknown>,
  dashName: string
): Promise<number | null> {
  // The import servlet expects a multipart/form-data upload (like a browser file picker),
  // not a JSON body. Sending Content-Type: application/json returns HTTP 500.
  const form = new FormData();
  form.append(
    "file",
    new Blob([JSON.stringify(exportJson)], { type: "application/json" }),
    "dashboard.json"
  );

  const response = await appdPostFormData<unknown>(
    "/controller/CustomDashboardImportExportServlet",
    form
  );

  // Tier 1: response is { id: N } or { dashboardId: N } or { dashboard: { id: N } }
  if (response !== null && typeof response === "object" && !Array.isArray(response)) {
    const r = response as Record<string, unknown>;
    if (typeof r["id"] === "number") return r["id"];
    if (typeof r["dashboardId"] === "number") return r["dashboardId"];
    // Actual AppDynamics servlet response: { success: true, dashboard: { id: N, ... } }
    const nested = r["dashboard"];
    if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
      const n = nested as Record<string, unknown>;
      if (typeof n["id"] === "number") return n["id"];
    }
  }
  // Tier 2: response is [{ id: N, ... }]
  if (Array.isArray(response) && response.length > 0) {
    const first = response[0] as Record<string, unknown>;
    if (typeof first["id"] === "number") return first["id"];
  }
  // Tier 3: list all dashboards and find by exact name
  const dashboards = await appdGetRaw<DashboardSummary[]>(
    "/controller/restui/dashboards/getAllDashboardsByType/false"
  );
  const found = Array.isArray(dashboards)
    ? dashboards.find((d) => d.name === dashName)
    : undefined;
  return found?.id ?? null;
}

// ── RESTUI Format Builder ─────────────────────────────────────────────────────

/**
 * Build a widget payload that matches the AppDynamics restui dashboard API format.
 * Reverse-engineered from real dashboard responses.
 */
function buildWidgetPayload(
  w: WidgetInput,
  index: number
): Record<string, unknown> {
  // Map friendly type aliases to actual API types
  const typeMap: Record<string, string> = {
    AdvancedGraph: "TIMESERIES_GRAPH",
    GraphWidget: "TIMESERIES_GRAPH",
    MetricValue: "METRIC_VALUE",
    MetricLabelWidget: "METRIC_VALUE",
    HealthListWidget: "HEALTH_LIST",
    TextWidget: "TEXT",
    PieWidget: "PIE",
    GaugeWidget: "GAUGE",
  };
  const apiType = typeMap[w.type] ?? w.type;

  // Common base properties matching the real API format
  const base: Record<string, unknown> = {
    title: w.title,
    type: apiType,
    height: w.height,
    width: w.width,
    x: w.x,
    y: w.y,
    label: w.title,
    description: w.description ?? null,
    drillDownUrl: null,
    openUrlInCurrentTab: false,
    useMetricBrowserAsDrillDown: true,
    drillDownActionType: null,
    backgroundColor: COLOR_WHITE,
    color: COLOR_DARK,
    fontSize: 12,
    useAutomaticFontSize: false,
    borderEnabled: false,
    borderThickness: 0,
    borderColor: COLOR_BORDER,
    backgroundAlpha: 1.0,
    showValues: false,
    formatNumber: true,
    numDecimals: 0,
    removeZeros: true,
    backgroundColors: [COLOR_WHITE, COLOR_WHITE],
    compactMode: false,
    showTimeRange: false,
    renderIn3D: false,
    isGlobal: true,
    properties: [],
    missingEntities: null,
    minHeight: 0,
    minWidth: 0,
    widgetsMetricMatchCriterias: null,
    timeRangeSpecifierType: "BEFORE_NOW",
    startTime: null,
    endTime: null,
    customTimeRange: null,
    minutesBeforeAnchorTime: 15,
  };

  // ── TEXT widget ─────────────────────────────────────────────────────────
  if (apiType === "TEXT") {
    base.text = w.text ?? "";
    base.useMetricBrowserAsDrillDown = false;
    return base;
  }

  // ── HEALTH_LIST widget ──────────────────────────────────────────────────
  if (apiType === "HEALTH_LIST") {
    base.useMetricBrowserAsDrillDown = false;
    base.applicationId = w.applicationId ?? null;
    base.entityType = w.entityType ?? "POLICY";
    if (w.healthRuleIds?.length) {
      base.entitySelectionType = "SPECIFIED";
      base.entityIds = w.healthRuleIds;
      base.properties = [];
    } else {
      base.entitySelectionType = "ALL";
      base.entityIds = [];
    }
    base.iconSize = 20;
    base.iconPosition = "LEFT";
    base.showSearchBox = false;
    base.showList = true;
    base.showListHeader = false;
    base.showBarPie = true;
    base.showPie = false;
    base.innerRadius = 0;
    base.aggregationType = "RATIO";
    base.showCurrentHealthStatus = false;
    return base;
  }

  // ── Metric-based widgets: TIMESERIES_GRAPH, METRIC_VALUE, PIE, GAUGE ──
  if (w.metricPath && w.applicationId) {
    const pathParts = w.metricPath.split("|");
    const displayName = pathParts[pathParts.length - 1] ?? w.metricPath;

    base.widgetsMetricMatchCriterias = [
      {
        name: `Series ${index + 1}`,
        nameUnique: true,
        metricMatchCriteria: {
          applicationId: w.applicationId,
          metricExpression: {
            type: "LEAF_METRIC_EXPRESSION",
            literalValueExpression: false,
            literalValue: 0,
            metricDefinition: {
              type: "LOGICAL_METRIC",
              logicalMetricName: null,
              scope: null,
              metricId: 0,
            },
            functionType: "VALUE",
            displayName,
            inputMetricText: true,
            inputMetricPath: w.metricPath,
            value: 0,
          },
          rollupMetricData: apiType !== "TIMESERIES_GRAPH",
          expressionString: "",
          metricDisplayNameStyle: "DISPLAY_STYLE_AUTO",
          metricDisplayNameCustomFormat: null,
          metricDataFilter: {
            sortResultsAscending: false,
            maxResults: 10,
          },
          useActiveBaseline: false,
          baselineId: 0,
          includeAbove: false,
          includeBelow: false,
          includeBoth: false,
          includeBand12: false,
          includeBand23: false,
          includeBand34: false,
          includeBand45: false,
          includeShade: false,
          isIncludeAllInactiveServers: false,
          includeHistoricalNodes: false,
          excludeMaintenanceWindow: false,
          missingEntities: null,
        },
        seriesType: apiType === "PIE" ? "LINE" : "LINE",
        axisPosition: "LEFT",
        showRawMetricName: false,
        metricType: "METRIC_DATA",
        colorPalette: null,
      },
    ];

    // TIMESERIES_GRAPH extras
    if (apiType === "TIMESERIES_GRAPH") {
      base.showLegend = true;
      base.legendPosition = "POSITION_BOTTOM";
      base.legendColumnCount = 1;
      base.verticalAxisLabel = null;
      base.hideHorizontalAxis = null;
      base.horizontalAxisLabel = null;
      base.axisType = "LINEAR";
      base.stackMode = null;
      base.multipleYAxis = null;
      base.showEvents = null;
      base.eventFilter = null;
      base.interpolateDataGaps = false;
      base.showAllTooltips = null;
      base.staticThresholds = null;
    }

    // PIE extras
    if (apiType === "PIE") {
      base.showLabels = true;
      base.showLegend = true;
      base.legendPosition = "POSITION_BOTTOM";
      base.legendColumnCount = 1;
    }

    return base;
  }

  // Widget without metric binding
  if (w.applicationId) {
    base.applicationId = w.applicationId;
  }

  return base;
}

// ── RESTUI Metric Binding Helpers ─────────────────────────────────────────────

/**
 * Build a widgetsMetricMatchCriterias entry for RESTUI updateDashboard.
 * Uses BT_AFFECTED_EMC (the only valid AEMC type accepted by the RESTUI API).
 * type="ALL" for aggregate metrics, type="SPECIFIC" with btIds for per-BT.
 * IMPORTANT: widgetId and widgetGuid must come from the server-assigned values
 * after a widget is saved — not from a client-generated placeholder.
 */
function buildResuiMetricSeries(
  w: WidgetInput,
  widgetId: number,
  widgetGuid: string,
  dashboardId: number,
): unknown[] | null {
  if (!w.metricPath || !w.applicationId) return null;
  const segments = w.metricPath.split("|");
  const logicalMetricName = segments[segments.length - 1] ?? w.metricPath;
  const hasSpecificBTs = w.btIds && w.btIds.length > 0;
  // TIMESERIES_GRAPH needs false (returns individual time-series points).
  // METRIC_VALUE / GAUGE / PIE need true (aggregate to a single display value).
  const rollupMetricData = w.type !== "TIMESERIES_GRAPH" && w.type !== "GraphWidget";
  return [
    {
      id: 0,
      version: 0,
      name: "Series 0",
      nameUnique: true,
      widgetGuid,
      widgetId,
      dashboardId,
      seriesType: "LINE",
      axisPosition: "LEFT",
      showRawMetricName: false,
      colorPalette: null,
      metricType: "BUSINESS_TRANSACTION",
      metricMatchCriteria: {
        applicationId: w.applicationId,
        affectedEntityMatchCriteria: {
          aemcType: "BT_AFFECTED_EMC",
          type: hasSpecificBTs ? "SPECIFIC" : "ALL",
          componentIds: [],
          componentMatchCriteria: null,
          missingEntities: null,
          inverseOnSpecificEntities: false,
          businessTransactionIds: hasSpecificBTs ? w.btIds! : [],
          nameMatch: null,
          btTagInfoMatchCriteria: null,
        },
        evaluationScopeType: "TIER_AVERAGE",
        metricExpression: {
          type: "LEAF_METRIC_EXPRESSION",
          literalValueExpression: false,
          literalValue: 0,
          metricDefinition: {
            type: "LOGICAL_METRIC",
            logicalMetricName,
            scope: null,
            metricId: 0,
          },
          functionType: "VALUE",
          displayName: null,
          inputMetricText: false,
          inputMetricPath: `Root||` + w.metricPath.replace(/\|/g, "||"),
          extractedAppIdsFromAnalyticsMetric: null,
          value: 0,
        },
        rollupMetricData,
        expressionString: "",
        metricDisplayNameStyle: "DISPLAY_STYLE_AUTO",
        metricDisplayNameCustomFormat: null,
        metricDataFilter: { sortResultsAscending: false, maxResults: 20 },
        useActiveBaseline: false,
        baselineId: 0,
        includeAbove: false,
        includeBelow: false,
        includeBoth: false,
        includeBand12: false,
        includeBand23: false,
        includeBand34: false,
        includeBand45: false,
        includeShade: false,
        isIncludeAllInactiveServers: false,
        includeHistoricalNodes: false,
        excludeMaintenanceWindow: false,
        missingEntities: null,
      },
    },
  ];
}

/**
 * After importing a dashboard via servlet (which drops all metric bindings),
 * fetch the RESTUI representation (to get server-assigned widget ids/guids),
 * then bind metric criteria to each metric widget via a single updateDashboard call.
 * Non-fatal: swallows errors so the dashboard is still returned to the caller.
 */
async function bindMetricWidgets(
  dashId: number,
  metricWidgets: WidgetInput[],
): Promise<void> {
  const toUpdate = metricWidgets.filter(
    (w) => w.metricPath !== undefined && w.applicationId !== undefined,
  );
  if (toUpdate.length === 0) return;

  const widgetByTitle = new Map<string, WidgetInput>();
  for (const w of toUpdate) widgetByTitle.set(w.title, w);

  const dash = await appdGetRaw<Record<string, unknown>>(
    `/controller/restui/dashboards/dashboardIfUpdated/${dashId}/-1`,
  );
  const dashWidgets = (dash["widgets"] as Array<Record<string, unknown>>) ?? [];

  let hasChanges = false;
  const updatedWidgets = dashWidgets.map((w) => {
    const input = widgetByTitle.get(w["title"] as string);
    if (!input) return w;
    const criteria = buildResuiMetricSeries(
      input,
      w["id"] as number,
      w["guid"] as string,
      dashId,
    );
    if (!criteria) return w;
    hasChanges = true;
    return { ...w, widgetsMetricMatchCriterias: criteria };
  });

  if (!hasChanges) return;
  await appdPost("/controller/restui/dashboards/updateDashboard", {
    ...dash,
    widgets: updatedWidgets,
  });
}

/**
 * After importing via servlet, HEALTH_LIST widgets have properties.selectedEntityIds
 * set correctly but entityIds=[] and entitySelectionType=null, so AppD shows "All".
 * The working format (confirmed from existing dashboards) requires:
 *   entitySelectionType: "SPECIFIED"  (NOT null, NOT "ALL", NOT "SPECIFIC")
 *   entityIds: [ruleId]
 *   properties: []  (selectedEntityIds property not needed when SPECIFIED+entityIds is set)
 */
async function bindHealthListWidgets(dashId: number): Promise<void> {
  const dash = await appdGetRaw<Record<string, unknown>>(
    `/controller/restui/dashboards/dashboardIfUpdated/${dashId}/-1`,
  );
  const dashWidgets = (dash["widgets"] as Array<Record<string, unknown>>) ?? [];

  let hasChanges = false;
  const updatedWidgets = dashWidgets.map((w) => {
    if (w["type"] !== "HEALTH_LIST") return w;
    // Get rule ID from properties.selectedEntityIds (set by import servlet)
    const props = (w["properties"] as Array<Record<string, unknown>>) ?? [];
    const prop = props.find((p) => p["name"] === "selectedEntityIds");
    if (!prop) return w;
    const ruleId = parseInt(String(prop["value"]), 10);
    if (isNaN(ruleId)) return w;
    hasChanges = true;
    return {
      ...w,
      entitySelectionType: "SPECIFIED",
      entityIds: [ruleId],
      properties: [],  // Clear selectedEntityIds — SPECIFIED+entityIds is the canonical form
    };
  });

  if (!hasChanges) return;
  await appdPost("/controller/restui/dashboards/updateDashboard", {
    ...dash,
    widgets: updatedWidgets,
  });
}


