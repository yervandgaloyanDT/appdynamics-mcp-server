/**
 * Quick smoke-test for the tier/node scoping changes to health-rules.ts
 * Run with: node scripts/test-health-rule-scope.mjs
 *
 * Tests buildAffects() logic by reimplementing it exactly as in the source
 * so we can verify the output without needing a live AppDynamics instance.
 */

// ── Replicate the buildAffects function from src/tools/health-rules.ts ──────

function buildAffects(entityType, affectedTier, affectedNode) {
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
  }
}

// ── Test harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(label, actual, check) {
  try {
    check(actual);
    console.log(`  ✓  ${label}`);
    passed++;
  } catch (e) {
    console.error(`  ✗  ${label}`);
    console.error(`     Got:      ${JSON.stringify(actual)}`);
    console.error(`     Reason:   ${e.message}`);
    failed++;
  }
}

function eq(a, b) {
  const as = JSON.stringify(a);
  const bs = JSON.stringify(b);
  if (as !== bs) throw new Error(`expected ${bs} but got ${as}`);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log("\n=== TIER_NODE_HEALTH scoping ===");

const noScope = buildAffects("TIER_NODE_HEALTH");
assert(
  "no tier/node → ALL_TIERS_OR_NODES",
  noScope.affectedTierOrNode,
  v => eq(v, { tierOrNodeScope: "ALL_TIERS_OR_NODES" })
);

const tierScope = buildAffects("TIER_NODE_HEALTH", "WebTier");
assert(
  "affectedTier='WebTier' → SPECIFIC_TIERS",
  tierScope.affectedTierOrNode,
  v => eq(v, { tierOrNodeScope: "SPECIFIC_TIERS", tiers: [{ name: "WebTier" }] })
);

const nodeScope = buildAffects("TIER_NODE_HEALTH", undefined, "node1");
assert(
  "affectedNode='node1' → SPECIFIC_NODES",
  nodeScope.affectedTierOrNode,
  v => eq(v, { tierOrNodeScope: "SPECIFIC_NODES", nodes: [{ name: "node1" }] })
);

const nodePrecedence = buildAffects("TIER_NODE_HEALTH", "WebTier", "node1");
assert(
  "both tier+node → node takes precedence (SPECIFIC_NODES)",
  nodePrecedence.affectedTierOrNode,
  v => eq(v, { tierOrNodeScope: "SPECIFIC_NODES", nodes: [{ name: "node1" }] })
);

console.log("\n=== TIER_NODE_TRANSACTION_PERFORMANCE scoping ===");

const tntpTier = buildAffects("TIER_NODE_TRANSACTION_PERFORMANCE", "BackendTier");
assert(
  "affectedTier='BackendTier' → SPECIFIC_TIERS",
  tntpTier.affectedTierOrNode,
  v => eq(v, { tierOrNodeScope: "SPECIFIC_TIERS", tiers: [{ name: "BackendTier" }] })
);

const tntpNode = buildAffects("TIER_NODE_TRANSACTION_PERFORMANCE", undefined, "srv-01");
assert(
  "affectedNode='srv-01' → SPECIFIC_NODES",
  tntpNode.affectedTierOrNode,
  v => eq(v, { tierOrNodeScope: "SPECIFIC_NODES", nodes: [{ name: "srv-01" }] })
);

console.log("\n=== Other entity types unaffected ===");

const bt = buildAffects("BUSINESS_TRANSACTION_PERFORMANCE");
assert(
  "BUSINESS_TRANSACTION_PERFORMANCE unchanged",
  bt.affectedBusinessTransactions,
  v => eq(v, { businessTransactionScope: "ALL_BUSINESS_TRANSACTIONS" })
);

const app = buildAffects("APPLICATION_PERFORMANCE");
assert(
  "APPLICATION_PERFORMANCE unchanged",
  app.affectedApplicationPerformance,
  v => eq(v, { applicationPerformanceScope: "ALL_TIERS" })
);

const be = buildAffects("BACKEND_CALL_PERFORMANCE");
assert(
  "BACKEND_CALL_PERFORMANCE unchanged",
  be.affectedBackend,
  v => eq(v, { backendScope: "ALL_BACKENDS" })
);

const se = buildAffects("SERVICE_ENDPOINT_PERFORMANCE");
assert(
  "SERVICE_ENDPOINT_PERFORMANCE unchanged",
  se.affectedServiceEndpoints,
  v => eq(v, { serviceEndpointScope: "ALL_SERVICE_ENDPOINTS" })
);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(44)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
