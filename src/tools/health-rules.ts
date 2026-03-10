/**
 * Tools: appd_get_health_rules, appd_create_health_rule, appd_update_health_rule,
 *        appd_delete_health_rule, appd_enable_health_rule
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { appdGet, appdPost, appdPut, appdDelete } from "../services/api-client.js";
import { resolveAppId } from "../utils/app-resolver.js";
import { handleError, textResponse } from "../utils/error-handler.js";
import { truncateIfNeeded } from "../utils/formatting.js";
import type { HealthRule, HealthRulePayload, HealthRuleCondition } from "../types.js";

const ALERTING_BASE = (appId: number) =>
  `/controller/alerting/rest/v1/applications/${appId}/health-rules`;

// ── Shared schemas ────────────────────────────────────────────────────────────

const ConditionSchema = z.object({
  metricPath: z.string().describe(
    'Metric path relative to the affected entity. ' +
    'For TIER_NODE_HEALTH: use short paths like "Custom Metrics|MyMetric" or "Hardware Resources|CPU|%Busy". ' +
    'Do NOT use the full absolute path (e.g. "Application Infrastructure Performance|Tier|...").'
  ),
  threshold: z.number().describe("Threshold value"),
  operator: z
    .enum(["GREATER_THAN", "LESS_THAN", "GREATER_THAN_EQUALS", "LESS_THAN_EQUALS", "EQUALS", "NOT_EQUALS"])
    .default("GREATER_THAN")
    .describe("Comparison operator. NOT_EQUALS is supported for CUSTOM (SIM) entity type rules."),
  name: z.string().optional().describe("Condition name (auto-generated if omitted)"),
});

const AFFECTED_ENTITY_TYPES = [
  "BUSINESS_TRANSACTION_PERFORMANCE",
  "APPLICATION_PERFORMANCE",
  "TIER_NODE_HEALTH",
  "TIER_NODE_TRANSACTION_PERFORMANCE",
  "BACKEND_CALL_PERFORMANCE",
  "SERVICE_ENDPOINT_PERFORMANCE",
  "CUSTOM",
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildAffects(
  entityType: (typeof AFFECTED_ENTITY_TYPES)[number],
  affectedTier?: string,
  affectedNode?: string,
  customEntityType?: string,
  customEntityName?: string,
): Record<string, unknown> {
  const base = { affectedEntityType: entityType };
  switch (entityType) {
    case "BUSINESS_TRANSACTION_PERFORMANCE":
      return { ...base, affectedBusinessTransactions: { businessTransactionScope: "ALL_BUSINESS_TRANSACTIONS" } };
    case "APPLICATION_PERFORMANCE":
      return { ...base, affectedApplicationPerformance: { applicationPerformanceScope: "ALL_TIERS" } };
    case "TIER_NODE_HEALTH":
    case "TIER_NODE_TRANSACTION_PERFORMANCE": {
      if (affectedNode) {
        return { ...base, affectedTierOrNode: { tierOrNodeScope: "SPECIFIC_NODES", nodes: [{ name: affectedNode }] } };
      }
      if (affectedTier) {
        return { ...base, affectedTierOrNode: { tierOrNodeScope: "SPECIFIC_TIERS", tiers: [{ name: affectedTier }] } };
      }
      return { ...base, affectedTierOrNode: { tierOrNodeScope: "ALL_TIERS_OR_NODES" } };
    }
    case "BACKEND_CALL_PERFORMANCE":
      return { ...base, affectedBackend: { backendScope: "ALL_BACKENDS" } };
    case "SERVICE_ENDPOINT_PERFORMANCE":
      return { ...base, affectedServiceEndpoints: { serviceEndpointScope: "ALL_SERVICE_ENDPOINTS" } };
    case "CUSTOM":
      return {
        ...base,
        affectedEntityScope: {
          entityScope: "SPECIFIC_ENTITY_PERFORMANCE",
          entityType: customEntityType ?? "SERVER",
          affectedEntityName: customEntityName ?? "",
        },
      };
  }
}

function buildConditions(
  items: Array<{ metricPath: string; threshold: number; operator: string; name?: string }>,
  simFormat = false,
): HealthRuleCondition[] {
  return items.map((c, i) => {
    // SIM (CUSTOM entity type) requires extra fields and uses _SPECIFIC_VALUE suffix on operators
    if (simFormat) {
      return {
        name: c.name ?? `Condition ${i + 1}`,
        shortName: String.fromCharCode(65 + i), // A, B, C…
        evaluateToTrueOnNoData: false,
        violationStatusOnNoData: "UNKNOWN",
        wildcardMetricMatchType: "DEFAULT_ALL_METRIC_PATH",
        evalDetail: {
          evalDetailType: "SINGLE_METRIC",
          metricAggregateFunction: "VALUE",
          metricPath: c.metricPath,
          metricEvalDetail: {
            metricEvalDetailType: "SPECIFIC_TYPE",
            compareCondition: c.operator,
            compareValue: c.threshold,
          },
          inputMetricText: false,
        },
        triggerEnabled: false,
        minimumTriggers: 0,
      } as unknown as HealthRuleCondition;
    }
    return {
      name: c.name ?? `Condition ${i + 1}`,
      shortcutAlerted: false,
      evalDetail: {
        evalDetailType: "SINGLE_METRIC",
        metricAggregateFunction: "VALUE",
        metricPath: c.metricPath,
        metricEvalDetail: {
          metricEvalDetailType: "SPECIFIC_TYPE",
          compareCondition: c.operator,
          compareValue: c.threshold,
        },
      },
    };
  });
}

function buildPayload(params: {
  name: string;
  enabled: boolean;
  affectedEntityType: (typeof AFFECTED_ENTITY_TYPES)[number];
  affectedTier?: string;
  affectedNode?: string;
  customEntityType?: string;
  customEntityName?: string;
  useDataFromLastNMinutes: number;
  waitTimeAfterViolation: number;
  conditionAggregationType: "ALL" | "ANY";
  criticalConditions: Array<{ metricPath: string; threshold: number; operator: string; name?: string }>;
  warningConditions?: Array<{ metricPath: string; threshold: number; operator: string; name?: string }>;
}): HealthRulePayload {
  const simFormat = params.affectedEntityType === "CUSTOM";
  const evalMatchingCriteria = simFormat ? { matchType: "ANY", value: null } : undefined;
  return {
    name: params.name,
    enabled: params.enabled,
    useDataFromLastNMinutes: params.useDataFromLastNMinutes,
    waitTimeAfterViolation: params.waitTimeAfterViolation,
    ...(simFormat ? { splitEventsByMetrics: false, scheduleName: "Always" } : {}),
    affects: buildAffects(params.affectedEntityType, params.affectedTier, params.affectedNode, params.customEntityType, params.customEntityName),
    evalCriterias: {
      criticalCriteria: {
        conditionAggregationType: params.conditionAggregationType,
        shortcutAlertEnabled: false,
        conditions: buildConditions(params.criticalConditions, simFormat),
        ...(simFormat ? { conditionExpression: null, evalMatchingCriteria } : {}),
      } as ReturnType<typeof buildPayload>["evalCriterias"]["criticalCriteria"],
      warningCriteria: {
        conditionAggregationType: params.conditionAggregationType,
        shortcutAlertEnabled: false,
        conditions: buildConditions(params.warningConditions ?? [], simFormat),
        ...(simFormat ? { conditionExpression: null, evalMatchingCriteria } : {}),
      } as ReturnType<typeof buildPayload>["evalCriterias"]["warningCriteria"],
    },
  };
}

// ── Tool registration ─────────────────────────────────────────────────────────

export function registerHealthRuleTools(server: McpServer): void {
  // ── appd_get_health_rules ─────────────────────────────────────────────────
  server.registerTool(
    "appd_get_health_rules",
    {
      title: "List Health Rules",
      description: `List health rules configured for an application, or get details of a specific health rule.

Health rules define the thresholds and conditions that trigger violations. Understanding what health rules exist and their configuration is essential context for interpreting violations.

Without healthRuleId: returns a summary list of all health rules (id, name, type, enabled, affected entity type).
With healthRuleId: returns the full configuration of that specific health rule including evaluation criteria.

Args:
  - application (string|number): App name or ID
  - healthRuleId (number, optional): Specific health rule ID for details

Returns: Array of health rules or single detailed health rule object.`,
      inputSchema: {
        application: z
          .union([z.string(), z.number()])
          .describe("Application name or numeric ID."),
        healthRuleId: z
          .number()
          .int()
          .optional()
          .describe("Optional: specific health rule ID to get detailed info."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ application, healthRuleId }) => {
      try {
        const appId = await resolveAppId(application);

        if (healthRuleId !== undefined) {
          const rule = await appdGet<HealthRule>(
            `/controller/rest/applications/${appId}/health-rules/${healthRuleId}`
          );
          return textResponse(JSON.stringify(rule, null, 2));
        }

        const rules = await appdGet<HealthRule[]>(
          `/controller/rest/applications/${appId}/health-rules`
        );

        const summary = rules.map((r) => ({
          id: r.id,
          name: r.name,
          type: r.type,
          enabled: r.enabled,
          isDefault: r.isDefault,
          affectedEntityType: r.affectedEntityType,
        }));

        return textResponse(truncateIfNeeded(summary));
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // ── appd_create_health_rule ───────────────────────────────────────────────
  server.registerTool(
    "appd_create_health_rule",
    {
      title: "Create Health Rule",
      description: `Create a new health rule for an application.

Supports APM and SIM (Server & Infrastructure Monitoring) entity types.
At least one critical condition is required.

Args:
  - application (string|number): App name or ID
  - name (string): Health rule name
  - enabled (boolean, default true)
  - affectedEntityType: BUSINESS_TRANSACTION_PERFORMANCE | APPLICATION_PERFORMANCE | TIER_NODE_HEALTH | TIER_NODE_TRANSACTION_PERFORMANCE | BACKEND_CALL_PERFORMANCE | SERVICE_ENDPOINT_PERFORMANCE | CUSTOM
  - affectedTier (string, optional): Scope to a specific tier (TIER_NODE_HEALTH / TIER_NODE_TRANSACTION_PERFORMANCE only)
  - affectedNode (string, optional): Scope to a specific node (takes precedence over affectedTier)
  - customEntityType (string, optional): Entity type for CUSTOM rules — use "SERVER" for SIM nodes
  - customEntityName (string, optional): Entity name for CUSTOM rules — use the server/node hostname
  - criticalConditions (array): at least one condition with metricPath, threshold, operator
  - warningConditions (array, optional): same structure
  - conditionAggregationType (ALL|ANY, default ALL)
  - useDataFromLastNMinutes (default 30)
  - waitTimeAfterViolation (default 30)

**APM custom metrics** (machine agent on APM app): use affectedEntityType=TIER_NODE_HEALTH with affectedTier or affectedNode.
metricPath must be RELATIVE to the entity (e.g. "Custom Metrics|MyMetric").

**SIM / URL Monitor metrics**: use affectedEntityType=CUSTOM, customEntityType="SERVER", customEntityName=<hostname>.
metricPath must be the FULL absolute path starting with "Application Infrastructure Performance|...".
Operators supported: GREATER_THAN, LESS_THAN, GREATER_THAN_EQUALS, LESS_THAN_EQUALS, EQUALS, NOT_EQUALS.
Example: { metricPath: "Application Infrastructure Performance|Root|Individual Nodes|myhost|Custom Metrics|URL Monitor|SvcA|Status", threshold: 4, operator: "NOT_EQUALS" }

Returns: Created health rule object with assigned ID.`,
      inputSchema: {
        application: z.union([z.string(), z.number()]).describe("Application name or numeric ID."),
        name: z.string().describe("Health rule name."),
        enabled: z.boolean().default(true).describe("Whether the rule is enabled."),
        affectedEntityType: z
          .enum(AFFECTED_ENTITY_TYPES)
          .describe("Entity type the health rule applies to."),
        affectedTier: z.string().optional().describe(
          "Scope to a specific tier (TIER_NODE_HEALTH / TIER_NODE_TRANSACTION_PERFORMANCE only). " +
          "Use when custom metrics only exist on nodes in a particular tier."
        ),
        affectedNode: z.string().optional().describe(
          "Scope to a specific node (TIER_NODE_HEALTH / TIER_NODE_TRANSACTION_PERFORMANCE only). " +
          "Takes precedence over affectedTier when both are provided."
        ),
        customEntityType: z.string().optional().describe(
          'Entity type for CUSTOM (SIM) rules. Use "SERVER" for Server & Infrastructure Monitoring nodes.'
        ),
        customEntityName: z.string().optional().describe(
          "Entity name for CUSTOM (SIM) rules. Use the server hostname (e.g. ip-10-0-1-163.eu-west-1.compute.internal)."
        ),
        criticalConditions: z
          .array(ConditionSchema)
          .min(1)
          .describe("Critical threshold conditions (at least one required)."),
        warningConditions: z
          .array(ConditionSchema)
          .optional()
          .describe("Warning threshold conditions."),
        conditionAggregationType: z
          .enum(["ALL", "ANY"])
          .default("ALL")
          .describe("ALL = all conditions must be met; ANY = any condition triggers."),
        useDataFromLastNMinutes: z
          .number()
          .int()
          .default(30)
          .describe("Evaluation window in minutes."),
        waitTimeAfterViolation: z
          .number()
          .int()
          .default(30)
          .describe("Wait time in minutes before re-alerting."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
      application,
      name,
      enabled,
      affectedEntityType,
      affectedTier,
      affectedNode,
      customEntityType,
      customEntityName,
      criticalConditions,
      warningConditions,
      conditionAggregationType,
      useDataFromLastNMinutes,
      waitTimeAfterViolation,
    }) => {
      try {
        const appId = await resolveAppId(application);
        const payload = buildPayload({
          name,
          enabled,
          affectedEntityType,
          affectedTier,
          affectedNode,
          customEntityType,
          customEntityName,
          useDataFromLastNMinutes,
          waitTimeAfterViolation,
          conditionAggregationType,
          criticalConditions,
          warningConditions,
        });
        const created = await appdPost<HealthRule>(ALERTING_BASE(appId), payload);
        return textResponse(
          `Health rule created successfully.\n\n${JSON.stringify(created, null, 2)}`
        );
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // ── appd_update_health_rule ───────────────────────────────────────────────
  server.registerTool(
    "appd_update_health_rule",
    {
      title: "Update Health Rule",
      description: `Update an existing health rule by ID.

Fetches the current rule, merges the provided fields, then PUTs the updated rule back.
Only fields you supply are changed; unspecified fields retain their current values.

Args:
  - application (string|number): App name or ID
  - healthRuleId (number): ID of the health rule to update
  - name, enabled, affectedEntityType, criticalConditions, warningConditions,
    conditionAggregationType, useDataFromLastNMinutes, waitTimeAfterViolation — all optional

Returns: Updated health rule object.`,
      inputSchema: {
        application: z.union([z.string(), z.number()]).describe("Application name or numeric ID."),
        healthRuleId: z.number().int().describe("ID of the health rule to update."),
        name: z.string().optional().describe("New health rule name."),
        enabled: z.boolean().optional().describe("Enable or disable the rule."),
        affectedEntityType: z.enum(AFFECTED_ENTITY_TYPES).optional().describe("Entity type."),
        affectedTier: z.string().optional().describe(
          "Scope to a specific tier (TIER_NODE_HEALTH / TIER_NODE_TRANSACTION_PERFORMANCE only). " +
          "Use when custom metrics only exist on nodes in a particular tier."
        ),
        affectedNode: z.string().optional().describe(
          "Scope to a specific node (TIER_NODE_HEALTH / TIER_NODE_TRANSACTION_PERFORMANCE only). " +
          "Takes precedence over affectedTier when both are provided."
        ),
        customEntityType: z.string().optional().describe(
          'Entity type for CUSTOM (SIM) rules. Use "SERVER" for SIM nodes.'
        ),
        customEntityName: z.string().optional().describe(
          "Entity name for CUSTOM (SIM) rules. Use the server hostname."
        ),
        criticalConditions: z.array(ConditionSchema).min(1).optional().describe("Critical conditions."),
        warningConditions: z.array(ConditionSchema).optional().describe("Warning conditions."),
        conditionAggregationType: z.enum(["ALL", "ANY"]).optional().describe("ALL or ANY."),
        useDataFromLastNMinutes: z.number().int().optional().describe("Evaluation window in minutes."),
        waitTimeAfterViolation: z.number().int().optional().describe("Re-alert wait time in minutes."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({
      application,
      healthRuleId,
      name,
      enabled,
      affectedEntityType,
      affectedTier,
      affectedNode,
      customEntityType,
      customEntityName,
      criticalConditions,
      warningConditions,
      conditionAggregationType,
      useDataFromLastNMinutes,
      waitTimeAfterViolation,
    }) => {
      try {
        const appId = await resolveAppId(application);
        const current = await appdGet<HealthRule>(
          `${ALERTING_BASE(appId)}/${healthRuleId}`
        );

        // Merge user-supplied fields over the current rule
        const merged: Record<string, unknown> = { ...current };
        if (name !== undefined) merged["name"] = name;
        if (enabled !== undefined) merged["enabled"] = enabled;
        if (useDataFromLastNMinutes !== undefined) merged["useDataFromLastNMinutes"] = useDataFromLastNMinutes;
        if (waitTimeAfterViolation !== undefined) merged["waitTimeAfterViolation"] = waitTimeAfterViolation;

        if (affectedEntityType !== undefined) {
          merged["affects"] = buildAffects(affectedEntityType, affectedTier, affectedNode, customEntityType, customEntityName);
        }

        if (criticalConditions !== undefined || warningConditions !== undefined || conditionAggregationType !== undefined) {
          const existingCriteria = (current["evalCriterias"] ?? {}) as Record<string, unknown>;
          const existingCrit = (existingCriteria["criticalCriteria"] ?? {}) as Record<string, unknown>;
          const existingWarn = (existingCriteria["warningCriteria"] ?? {}) as Record<string, unknown>;
          const aggType = conditionAggregationType ??
            (existingCrit["conditionAggregationType"] as string | undefined) ?? "ALL";

          merged["evalCriterias"] = {
            criticalCriteria: {
              conditionAggregationType: aggType,
              shortcutAlertEnabled: false,
              conditions: criticalConditions
                ? buildConditions(criticalConditions)
                : existingCrit["conditions"] ?? [],
            },
            warningCriteria: {
              conditionAggregationType: aggType,
              shortcutAlertEnabled: false,
              conditions: warningConditions
                ? buildConditions(warningConditions)
                : existingWarn["conditions"] ?? [],
            },
          };
        }

        const updated = await appdPut<HealthRule>(
          `${ALERTING_BASE(appId)}/${healthRuleId}`,
          merged
        );
        return textResponse(
          `Health rule updated successfully.\n\n${JSON.stringify(updated, null, 2)}`
        );
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // ── appd_delete_health_rule ───────────────────────────────────────────────
  server.registerTool(
    "appd_delete_health_rule",
    {
      title: "Delete Health Rule",
      description: `Permanently delete a health rule by ID.

This action cannot be undone. Use appd_get_health_rules to confirm the ID before deleting.

Args:
  - application (string|number): App name or ID
  - healthRuleId (number): ID of the health rule to delete

Returns: Confirmation message.`,
      inputSchema: {
        application: z.union([z.string(), z.number()]).describe("Application name or numeric ID."),
        healthRuleId: z.number().int().describe("ID of the health rule to delete."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ application, healthRuleId }) => {
      try {
        const appId = await resolveAppId(application);
        await appdDelete(`${ALERTING_BASE(appId)}/${healthRuleId}`);
        return textResponse(`Health rule ${healthRuleId} deleted successfully.`);
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // ── appd_enable_health_rule ───────────────────────────────────────────────
  server.registerTool(
    "appd_enable_health_rule",
    {
      title: "Enable / Disable Health Rule",
      description: `Enable or disable a health rule without changing any other settings.

Fetches the current rule, sets the enabled flag, and PUTs it back.

Args:
  - application (string|number): App name or ID
  - healthRuleId (number): ID of the health rule
  - enabled (boolean): true to enable, false to disable

Returns: Updated health rule object.`,
      inputSchema: {
        application: z.union([z.string(), z.number()]).describe("Application name or numeric ID."),
        healthRuleId: z.number().int().describe("ID of the health rule."),
        enabled: z.boolean().describe("true to enable the rule, false to disable it."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ application, healthRuleId, enabled }) => {
      try {
        const appId = await resolveAppId(application);
        const current = await appdGet<HealthRule>(`${ALERTING_BASE(appId)}/${healthRuleId}`);
        const updated = await appdPut<HealthRule>(
          `${ALERTING_BASE(appId)}/${healthRuleId}`,
          { ...current, enabled }
        );
        return textResponse(
          `Health rule ${healthRuleId} ${enabled ? "enabled" : "disabled"} successfully.\n\n${JSON.stringify(updated, null, 2)}`
        );
      } catch (error) {
        return handleError(error);
      }
    }
  );
}
