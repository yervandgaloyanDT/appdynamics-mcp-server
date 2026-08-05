import { describe, expect, it } from "vitest";
import {
  applyMetricBoosts,
  buildCausalityChain,
  buildInvestigationSteps,
  buildSummary,
  buildTimeline,
  collectAffectedEntities,
  computeChangePct,
  correlate,
  estimateIssueStart,
  extractErrorMessage,
  extractMetricAverage,
  normalizeViolations,
  rankCandidates,
  scoreEntity,
  sortErrorBreakdown,
  summarizeSnapshot,
  type EntityMap,
} from "../src/tools/root-cause-analysis.js";
import type {
  AppDEvent,
  BackendMetricSummary,
  HealthRuleViolation,
  InfraNodeSummary,
  TierMetricSummary,
} from "../src/types.js";

const violation = (over: Partial<HealthRuleViolation> = {}): HealthRuleViolation =>
  ({
    name: "High CPU",
    severity: "CRITICAL",
    affectedEntityType: "APPLICATION_COMPONENT",
    affectedEntityName: "FrontEnd",
    startTimeInMillis: 1_700_000_000_000,
    ...over,
  }) as HealthRuleViolation;

const event = (over: Partial<AppDEvent> = {}): AppDEvent =>
  ({
    type: "APPLICATION_ERROR",
    severity: "ERROR",
    affectedEntityType: "APPLICATION_COMPONENT",
    affectedEntityName: "FrontEnd",
    eventTime: 1_700_000_100_000,
    summary: "NullPointerException at com.example.Foo",
    ...over,
  }) as AppDEvent;

const tierMetric = (over: Partial<TierMetricSummary> = {}): TierMetricSummary => ({
  tierName: "FrontEnd",
  avgResponseMs: 900,
  baselineAvgResponseMs: 300,
  responseChangePct: 200,
  errorsPerMin: 0,
  baselineErrorsPerMin: 0,
  errorsChangePct: null,
  isSlowResponse: true,
  hasNewErrors: false,
  ...over,
});

const infraNode = (over: Partial<InfraNodeSummary> = {}): InfraNodeSummary => ({
  tierName: "FrontEnd",
  nodeName: "node-1",
  cpuPercent: 95,
  baselineCpuPercent: 40,
  cpuChangePct: 137,
  heapUsedMb: 1800,
  baselineHeapUsedMb: 1200,
  gcTimeMs: 400,
  baselineGcTimeMs: 100,
  gcChangePct: 300,
  isCpuSaturated: true,
  isHeapPressure: true,
  hasGcPressure: true,
  ...over,
});

const backend = (over: Partial<BackendMetricSummary> = {}): BackendMetricSummary => ({
  name: "orders-db",
  type: "JDBC",
  avgResponseMs: 800,
  baselineAvgResponseMs: 200,
  responseChangePct: 300,
  errorsPerMin: 2.5,
  baselineErrorsPerMin: 0,
  isSlow: true,
  ...over,
});

describe("normalizeViolations", () => {
  it("passes a bare array through", () => {
    expect(normalizeViolations([{ name: "x" }])).toEqual([{ name: "x" }]);
  });

  it("unwraps each envelope shape the controller uses", () => {
    expect(normalizeViolations({ healthRuleViolations: [{ name: "a" }] })).toHaveLength(1);
    expect(normalizeViolations({ violations: [{ name: "b" }] })).toHaveLength(1);
    expect(normalizeViolations({ data: [{ name: "c" }] })).toHaveLength(1);
  });

  it("keeps only health-rule entries from the /problems fallback", () => {
    const result = normalizeViolations({
      problems: [
        { type: "HEALTH_RULE_VIOLATION", name: "one" },
        { triggeredEntityType: "HEALTH_RULE", name: "two" },
        { name: "Health check three" },
        { type: "SOMETHING_ELSE", name: "ignored" },
      ],
    });
    expect(result.map((r) => r.name)).toEqual(["one", "two", "Health check three"]);
  });

  it("returns empty for unusable input", () => {
    expect(normalizeViolations(null)).toEqual([]);
    expect(normalizeViolations("nope")).toEqual([]);
    expect(normalizeViolations({})).toEqual([]);
  });
});

describe("extractMetricAverage", () => {
  it("weights by count rather than averaging bucket values", () => {
    // 1000/10 and 100/1 → (1000+100)/(10+1) = 100, not the 550 a naive mean gives.
    const data = [
      {
        metricValues: [
          { sum: 1000, count: 10 },
          { sum: 100, count: 1 },
        ],
      },
    ];
    expect(extractMetricAverage(data)).toBe(100);
  });

  it("ignores zero-count buckets", () => {
    const data = [{ metricValues: [{ sum: 0, count: 0 }, { sum: 50, count: 5 }] }];
    expect(extractMetricAverage(data)).toBe(10);
  });

  it("returns null when there is nothing to average", () => {
    expect(extractMetricAverage([])).toBeNull();
    expect(extractMetricAverage([{ metricValues: [] }])).toBeNull();
    expect(extractMetricAverage([{ metricValues: [{ sum: 5, count: 0 }] }])).toBeNull();
    expect(extractMetricAverage(null)).toBeNull();
  });
});

describe("computeChangePct", () => {
  it("computes percentage degradation", () => {
    expect(computeChangePct(300, 100)).toBe(200);
    expect(computeChangePct(50, 100)).toBe(-50);
  });

  it("suppresses comparison against a trivially small baseline", () => {
    // 2ms → 4ms is +100% but meaningless; the floor keeps it out of the report.
    expect(computeChangePct(4, 2, 20)).toBeNull();
    expect(computeChangePct(400, 200, 20)).toBe(100);
  });

  it("returns null when either side is missing", () => {
    expect(computeChangePct(null, 100)).toBeNull();
    expect(computeChangePct(100, null)).toBeNull();
  });
});

describe("correlate", () => {
  it("aggregates issues per affected entity", () => {
    const { entities } = correlate(
      [violation(), violation({ severity: "WARNING", name: "Slow BT" })],
      [event()],
      []
    );
    const rec = entities.get("APPLICATION_COMPONENT::FrontEnd")!;
    expect(rec.issueCount).toBe(3);
    expect(rec.criticalCount).toBe(2); // one CRITICAL violation + one ERROR event
    expect(rec.warningCount).toBe(1);
  });

  it("tracks the highest severity seen", () => {
    const { entities } = correlate(
      [violation({ severity: "WARNING" }), violation({ severity: "CRITICAL" })],
      [],
      []
    );
    expect(entities.get("APPLICATION_COMPONENT::FrontEnd")!.highestSeverity).toBe(
      "CRITICAL"
    );
  });

  it("does not downgrade severity when a milder issue arrives later", () => {
    const { entities } = correlate(
      [violation({ severity: "CRITICAL" }), violation({ severity: "WARNING" })],
      [],
      []
    );
    expect(entities.get("APPLICATION_COMPONENT::FrontEnd")!.highestSeverity).toBe(
      "CRITICAL"
    );
  });

  it("separates entities of the same name but different type", () => {
    const { entities } = correlate(
      [
        violation({ affectedEntityType: "APPLICATION_COMPONENT" }),
        violation({ affectedEntityType: "APPLICATION_COMPONENT_NODE" }),
      ],
      [],
      []
    );
    expect(entities.size).toBe(2);
  });

  it("groups error events by exception class", () => {
    const { errorGroups } = correlate(
      [],
      [
        event({ summary: "NullPointerException at com.example.A" }),
        event({ summary: "NullPointerException at com.example.B" }),
        event({ summary: "SQLException connecting to db" }),
      ],
      []
    );
    expect(errorGroups.get("NullPointerException")).toBe(2);
    expect(errorGroups.get("SQLException")).toBe(1);
  });

  it("reads severity from the anomaly event type", () => {
    const { entities } = correlate(
      [],
      [],
      [
        event({ type: "ANOMALY_OPEN_CRITICAL", summary: undefined }),
        event({ type: "ANOMALY_OPEN_WARNING", summary: undefined }),
      ]
    );
    const rec = entities.get("APPLICATION_COMPONENT::FrontEnd")!;
    expect(rec.criticalCount).toBe(1);
    expect(rec.warningCount).toBe(1);
  });

  it("caps repeated evidence at five unique lines", () => {
    const { entities } = correlate(
      Array.from({ length: 50 }, (_, i) => violation({ name: `Rule ${i}` })),
      [],
      []
    );
    const rec = entities.get("APPLICATION_COMPONENT::FrontEnd")!;
    expect(rec.evidence).toHaveLength(5);
    expect(rec.issueCount).toBe(50);
  });

  it("deduplicates identical evidence", () => {
    const { entities } = correlate([violation(), violation(), violation()], [], []);
    expect(entities.get("APPLICATION_COMPONENT::FrontEnd")!.evidence).toEqual([
      "Health rule 'High CPU' CRITICAL",
    ]);
  });

  it("buckets an entity with no name under UNKNOWN", () => {
    const { entities } = correlate(
      [violation({ affectedEntityName: undefined, affectedEntityType: undefined })],
      [],
      []
    );
    expect(entities.has("UNKNOWN::UNKNOWN")).toBe(true);
  });
});

describe("collectAffectedEntities", () => {
  it("splits tiers, nodes and business transactions", () => {
    const { entities } = correlate(
      [
        violation({ affectedEntityType: "APPLICATION_COMPONENT", affectedEntityName: "FrontEnd" }),
        violation({ affectedEntityType: "APPLICATION_COMPONENT_NODE", affectedEntityName: "node-1" }),
        violation({ affectedEntityType: "BUSINESS_TRANSACTION", affectedEntityName: "/checkout" }),
      ],
      [],
      []
    );
    const affected = collectAffectedEntities(entities, []);
    expect([...affected.tiers]).toEqual(["FrontEnd"]);
    expect([...affected.nodes]).toEqual(["node-1"]);
    expect([...affected.bts]).toEqual(["/checkout"]);
  });

  it("implicates the tier hosting an affected business transaction", () => {
    const { entities } = correlate(
      [violation({ affectedEntityType: "BUSINESS_TRANSACTION", affectedEntityName: "/checkout" })],
      [],
      []
    );
    const affected = collectAffectedEntities(entities, [
      { id: 1, name: "/checkout", tierName: "OrderProcessing" },
    ] as never);
    expect([...affected.tiers]).toEqual(["OrderProcessing"]);
  });
});

describe("applyMetricBoosts", () => {
  function tierEntities(): EntityMap {
    return correlate([violation({ severity: "WARNING" })], [], []).entities;
  }

  it("weights a doubling more heavily than a marginal regression", () => {
    const severe = tierEntities();
    applyMetricBoosts(severe, [tierMetric({ responseChangePct: 200 })], []);

    const mild = tierEntities();
    applyMetricBoosts(mild, [tierMetric({ responseChangePct: 60 })], []);

    const key = "APPLICATION_COMPONENT::FrontEnd";
    expect(severe.get(key)!.criticalCount).toBe(3);
    expect(mild.get(key)!.criticalCount).toBe(1);
  });

  it("does not boost a tier whose metrics are flat", () => {
    const entities = tierEntities();
    applyMetricBoosts(
      entities,
      [tierMetric({ responseChangePct: 5, isSlowResponse: false })],
      []
    );
    expect(entities.get("APPLICATION_COMPONENT::FrontEnd")!.criticalCount).toBe(0);
  });

  it("records new errors as a warning", () => {
    const entities = tierEntities();
    applyMetricBoosts(
      entities,
      [tierMetric({ isSlowResponse: false, responseChangePct: null, hasNewErrors: true, errorsPerMin: 4 })],
      []
    );
    const rec = entities.get("APPLICATION_COMPONENT::FrontEnd")!;
    expect(rec.warningCount).toBe(2); // original WARNING violation + errors boost
    expect(rec.evidence.join(" ")).toContain("Errors/min: 4.0");
  });

  it("creates a node record for infrastructure pressure not already seen", () => {
    const entities: EntityMap = new Map();
    applyMetricBoosts(entities, [], [infraNode()]);
    const rec = entities.get("APPLICATION_COMPONENT_NODE::node-1")!;
    expect(rec).toBeDefined();
    expect(rec.criticalCount).toBe(5); // CPU >critical = 3, GC = 2
  });

  it("ignores a healthy node", () => {
    const entities: EntityMap = new Map();
    applyMetricBoosts(entities, [], [
      infraNode({ isCpuSaturated: false, hasGcPressure: false }),
    ]);
    expect(entities.size).toBe(0);
  });

  it("matches tier metrics only against tier-type entities", () => {
    // A BT that happens to share the tier's name must not absorb the tier's
    // degradation. Seeded as WARNING so any critical count can only come
    // from the boost under test.
    const { entities } = correlate(
      [
        violation({
          affectedEntityType: "BUSINESS_TRANSACTION",
          affectedEntityName: "FrontEnd",
          severity: "WARNING",
        }),
      ],
      [],
      []
    );
    applyMetricBoosts(entities, [tierMetric({ responseChangePct: 200 })], []);
    expect(entities.get("BUSINESS_TRANSACTION::FrontEnd")!.criticalCount).toBe(0);
  });
});

describe("rankCandidates", () => {
  it("orders by weighted score and drops the internal counters", () => {
    const entities: EntityMap = new Map([
      ["a", { entity: "A", entityType: "TIER", issueCount: 1, criticalCount: 0, warningCount: 1, otherCount: 0, highestSeverity: "WARNING", evidence: [] }],
      ["b", { entity: "B", entityType: "TIER", issueCount: 1, criticalCount: 2, warningCount: 0, otherCount: 0, highestSeverity: "CRITICAL", evidence: [] }],
    ]);
    const ranked = rankCandidates(entities);
    expect(ranked.map((r) => r.entity)).toEqual(["B", "A"]);
    expect(ranked[0]).not.toHaveProperty("criticalCount");
  });

  it("limits the candidate list", () => {
    const entities: EntityMap = new Map(
      Array.from({ length: 12 }, (_, i) => [
        String(i),
        { entity: `E${i}`, entityType: "TIER", issueCount: i, criticalCount: i, warningCount: 0, otherCount: 0, highestSeverity: "INFO", evidence: [] },
      ])
    );
    expect(rankCandidates(entities)).toHaveLength(5);
    expect(rankCandidates(entities, 2)).toHaveLength(2);
  });

  it("scores critical above warning above other", () => {
    const base = { entity: "x", entityType: "TIER", issueCount: 0, highestSeverity: "INFO", evidence: [] };
    expect(scoreEntity({ ...base, criticalCount: 1, warningCount: 0, otherCount: 0 })).toBe(3);
    expect(scoreEntity({ ...base, criticalCount: 0, warningCount: 1, otherCount: 0 })).toBe(2);
    expect(scoreEntity({ ...base, criticalCount: 0, warningCount: 0, otherCount: 1 })).toBe(1);
  });
});

describe("buildTimeline", () => {
  it("merges sources most-recent first", () => {
    const timeline = buildTimeline(
      [violation({ startTimeInMillis: 1_700_000_000_000 })],
      [event({ eventTime: 1_700_000_200_000 })],
      [event({ type: "ANOMALY_OPEN_CRITICAL", eventTime: 1_700_000_100_000 })]
    );
    expect(timeline).toHaveLength(3);
    expect(timeline[0]!.type).toBe("APPLICATION_ERROR");
    expect(timeline[2]!.type).toBe("HEALTH_RULE_OPEN_CRITICAL");
  });

  it("skips entries with no timestamp", () => {
    expect(
      buildTimeline(
        [violation({ startTimeInMillis: undefined, detectedTimeInMillis: undefined })],
        [event({ eventTime: undefined })],
        []
      )
    ).toEqual([]);
  });

  it("falls back to the detection time", () => {
    const timeline = buildTimeline(
      [violation({ startTimeInMillis: undefined, detectedTimeInMillis: 1_700_000_000_000 })],
      [],
      []
    );
    expect(timeline).toHaveLength(1);
  });

  it("caps the entry count", () => {
    const events = Array.from({ length: 100 }, (_, i) =>
      event({ eventTime: 1_700_000_000_000 + i * 1000 })
    );
    expect(buildTimeline([], events, [])).toHaveLength(30);
  });
});

describe("estimateIssueStart", () => {
  it("returns the earliest violation time", () => {
    const result = estimateIssueStart([
      violation({ startTimeInMillis: 1_700_000_500_000 }),
      violation({ startTimeInMillis: 1_700_000_000_000 }),
    ]);
    expect(result).toBe("2023-11-14 22:13:20 UTC");
  });

  it("returns null when nothing is timestamped", () => {
    expect(estimateIssueStart([])).toBeNull();
    expect(
      estimateIssueStart([
        violation({ startTimeInMillis: undefined, detectedTimeInMillis: undefined }),
      ])
    ).toBeNull();
  });
});

describe("sortErrorBreakdown", () => {
  it("orders classes by frequency", () => {
    expect(
      Object.entries(sortErrorBreakdown(new Map([["A", 2], ["B", 9], ["C", 5]])))
    ).toEqual([["B", 9], ["C", 5], ["A", 2]]);
  });
});

describe("buildSummary", () => {
  it("reports a healthy application", () => {
    expect(buildSummary([], [], [], "Last 60 minutes")).toMatch(/appears healthy/);
  });

  it("counts each category and calls out criticals", () => {
    const summary = buildSummary(
      [violation(), violation({ severity: "WARNING" })],
      [event()],
      [event(), event()],
      "Last 60 minutes"
    );
    expect(summary).toContain("2 health violations (1 CRITICAL)");
    expect(summary).toContain("1 anomaly");
    expect(summary).toContain("2 error/infrastructure events");
  });

  it("uses singular wording for a single violation", () => {
    expect(buildSummary([violation()], [], [], "w")).toContain("1 health violation (1 CRITICAL)");
  });
});

describe("buildCausalityChain", () => {
  it("orders infrastructure before backends before tiers", () => {
    const chain = buildCausalityChain(
      [infraNode({ tierName: "Inventory" })],
      [backend()],
      [tierMetric({ tierName: "FrontEnd" })],
      true
    );
    expect(chain[0]).toContain("CPU spike on node 'node-1'");
    expect(chain.some((c) => c.includes("Slow JDBC backend 'orders-db'"))).toBe(true);
    expect(chain.at(-1)).toContain("Tier 'FrontEnd' response degraded");
  });

  it("does not double-report a tier already explained by its node", () => {
    const chain = buildCausalityChain(
      [infraNode({ tierName: "FrontEnd" })],
      [],
      [tierMetric({ tierName: "FrontEnd" })],
      true
    );
    expect(chain.some((c) => c.includes("Tier 'FrontEnd' response degraded"))).toBe(false);
  });

  it("explains alerts that no metric movement accounts for", () => {
    const chain = buildCausalityChain([], [], [], true);
    expect(chain).toHaveLength(1);
    expect(chain[0]).toMatch(/no metric degradation detected/);
  });

  it("stays empty when nothing is wrong at all", () => {
    expect(buildCausalityChain([], [], [], false)).toEqual([]);
  });

  it("reports heap growth only when GC pressure has not already been reported", () => {
    const gcAndHeap = buildCausalityChain([infraNode()], [], [], false);
    expect(gcAndHeap.some((c) => c.includes("Heap growing"))).toBe(false);

    const heapOnly = buildCausalityChain(
      [infraNode({ hasGcPressure: false, isCpuSaturated: false })],
      [],
      [],
      false
    );
    expect(heapOnly[0]).toContain("Heap growing on 'node-1': 1800MB vs baseline 1200MB");
  });
});

describe("buildInvestigationSteps", () => {
  const base = {
    infraInsights: [],
    backendAnalysis: [],
    ranked: [],
    snapshotCount: 0,
    affectedBTs: new Set<string>(),
    errorBreakdown: {},
    violationCount: 0,
    issueStartedAround: null,
  };

  it("numbers steps consecutively across categories", () => {
    const steps = buildInvestigationSteps({
      ...base,
      infraInsights: [infraNode()],
      backendAnalysis: [backend()],
      ranked: [{ entity: "FrontEnd", entityType: "TIER", issueCount: 3 }],
    });
    expect(steps[0]!.startsWith("1. INFRA:")).toBe(true);
    expect(steps[1]!.startsWith("2. BACKEND:")).toBe(true);
    expect(steps[2]!.startsWith("3. Focus on 'FrontEnd'")).toBe(true);
  });

  it("caps infrastructure and backend steps at two each", () => {
    const steps = buildInvestigationSteps({
      ...base,
      infraInsights: [infraNode({ nodeName: "n1" }), infraNode({ nodeName: "n2" }), infraNode({ nodeName: "n3" })],
      backendAnalysis: [backend({ name: "b1" }), backend({ name: "b2" }), backend({ name: "b3" })],
    });
    expect(steps.filter((s) => s.includes("INFRA:"))).toHaveLength(2);
    expect(steps.filter((s) => s.includes("BACKEND:"))).toHaveLength(2);
  });

  it("names the most frequent error class", () => {
    const steps = buildInvestigationSteps({
      ...base,
      errorBreakdown: { NullPointerException: 12, SQLException: 3 },
    });
    expect(steps[0]).toContain("'NullPointerException'");
    expect(steps[0]).toContain("12 occurrences");
  });

  it("suggests a deployment check only when violations have a start time", () => {
    expect(
      buildInvestigationSteps({ ...base, violationCount: 2, issueStartedAround: "2026-08-05 10:00:00 UTC" })
        .some((s) => s.includes("check deployments"))
    ).toBe(true);

    expect(
      buildInvestigationSteps({ ...base, violationCount: 0, issueStartedAround: "2026-08-05 10:00:00 UTC" })
        .some((s) => s.includes("check deployments"))
    ).toBe(false);
  });

  it("gives a usable fallback when nothing is wrong", () => {
    const steps = buildInvestigationSteps(base);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toContain("No issues detected");
  });
});

describe("summarizeSnapshot", () => {
  it("keeps the diagnostic fields and drops the rest", () => {
    const result = summarizeSnapshot({
      requestGUID: "abc",
      applicationComponentName: "FrontEnd",
      timeTakenInMilliSecs: 4200,
      irrelevantField: "noise",
      unusedFlag: true,
    });
    expect(result["requestGUID"]).toBe("abc");
    expect(result["tier"]).toBe("FrontEnd");
    expect(result["responseTimeMs"]).toBe(4200);
    expect(result).not.toHaveProperty("irrelevantField");
  });

  it("trims a stack trace to its first five lines", () => {
    const result = summarizeSnapshot({
      errorDetails: Array.from({ length: 20 }, (_, i) => `  at frame${i}`).join("\n"),
    });
    expect(String(result["errorStackTrace"]).split(" | ")).toHaveLength(5);
  });

  it("caps sql and http exit calls at five", () => {
    const result = summarizeSnapshot({
      sqlQueries: Array.from({ length: 9 }, (_, i) => ({ query: `select ${i}` })),
      httpCallData: Array.from({ length: 9 }, (_, i) => ({ url: `http://x/${i}` })),
    });
    expect(result["sqlQueries"]).toHaveLength(5);
    expect(result["httpCalls"]).toHaveLength(5);
  });

  it("passes a non-object through untouched", () => {
    expect(summarizeSnapshot("raw string")).toEqual({ raw: "raw string" });
  });
});

describe("extractErrorMessage", () => {
  function axiosErr(status?: number, code?: string): Error {
    const e = new Error("boom") as Error & Record<string, unknown>;
    e["isAxiosError"] = true;
    if (status !== undefined) e["response"] = { status };
    if (code !== undefined) e["code"] = code;
    return e;
  }

  it("explains HTTP statuses in diagnostic terms", () => {
    expect(extractErrorMessage(axiosErr(401))).toMatch(/authentication failed/);
    expect(extractErrorMessage(axiosErr(403))).toMatch(/permission denied/);
    expect(extractErrorMessage(axiosErr(404))).toMatch(/may not be enabled/);
    expect(extractErrorMessage(axiosErr(429))).toMatch(/rate limit/);
    expect(extractErrorMessage(axiosErr(503))).toMatch(/HTTP error \(503\)/);
  });

  it("explains transport failures", () => {
    expect(extractErrorMessage(axiosErr(undefined, "ECONNABORTED"))).toMatch(/timed out/);
    expect(extractErrorMessage(axiosErr(undefined, "ENOTFOUND"))).toMatch(/cannot reach/);
  });

  it("passes plain errors and non-errors through", () => {
    expect(extractErrorMessage(new Error("plain"))).toBe("plain");
    expect(extractErrorMessage("just text")).toBe("just text");
  });
});
