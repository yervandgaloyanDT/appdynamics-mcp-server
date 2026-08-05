import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  SEP_METRICS,
  describeEndpoints,
  matchServiceEndpoints,
  parseMetricTreeNodes,
  sepMetricPath,
  sepNamesFromTree,
  sepPath,
  sepTierPath,
  type ServiceEndpointRef,
} from "../src/tools/service-endpoint-paths.js";

const here = dirname(fileURLToPath(import.meta.url));
const tree = JSON.parse(
  readFileSync(join(here, "fixtures", "metric-tree-service-endpoints.json"), "utf8")
) as {
  serviceEndpointsRoot: unknown;
  tierInventory: unknown;
  endpointHttpTo2nd: unknown;
};

describe("metric path construction", () => {
  it("addresses an endpoint metric tier-first", () => {
    // Verified live: this exact path returns data; the pre-fix shape
    // `Service Endpoints|<numericId>|<metric>` returned zero series.
    expect(sepMetricPath("Inventory", "/http/to2nd", "Calls per Minute")).toBe(
      "Service Endpoints|Inventory|/http/to2nd|Calls per Minute"
    );
  });

  it("builds tier and endpoint folder paths", () => {
    expect(sepTierPath("Inventory")).toBe("Service Endpoints|Inventory");
    expect(sepPath("Inventory", "/http/to2nd")).toBe(
      "Service Endpoints|Inventory|/http/to2nd"
    );
  });

  it("keeps slashes in endpoint names untouched", () => {
    expect(sepPath("FrontEnd", "/api/v2/orders")).toBe(
      "Service Endpoints|FrontEnd|/api/v2/orders"
    );
  });

  it("rejects names containing the path separator instead of emitting a bad path", () => {
    expect(() => sepPath("Inventory", "weird|name")).toThrow(/separator/);
    expect(() => sepTierPath("odd|tier")).toThrow(/separator/);
  });

  it("covers exactly the leaf metrics the controller reports", () => {
    const leaves = parseMetricTreeNodes(tree.endpointHttpTo2nd)
      .filter((n) => n.type === "leaf")
      .map((n) => n.name)
      .sort();
    expect([...SEP_METRICS].sort()).toEqual(leaves);
  });
});

describe("parseMetricTreeNodes", () => {
  it("reads the captured tree response", () => {
    expect(parseMetricTreeNodes(tree.serviceEndpointsRoot)).toEqual([
      { name: "Inventory", type: "folder" },
      { name: "FrontEnd", type: "folder" },
      { name: "OrderProcessing", type: "folder" },
    ]);
  });

  it("unwraps an object-wrapped response", () => {
    expect(
      parseMetricTreeNodes({ metricItems: [{ name: "FrontEnd", type: "folder" }] })
    ).toEqual([{ name: "FrontEnd", type: "folder" }]);
  });

  it("drops malformed entries rather than throwing", () => {
    expect(
      parseMetricTreeNodes([
        { name: "ok", type: "folder" },
        { name: "", type: "folder" },
        { type: "folder" },
        null,
        "nonsense",
        { name: "no-type" },
      ])
    ).toEqual([
      { name: "ok", type: "folder" },
      { name: "no-type", type: "" },
    ]);
  });

  it("returns empty for unusable input", () => {
    expect(parseMetricTreeNodes(null)).toEqual([]);
    expect(parseMetricTreeNodes(undefined)).toEqual([]);
    expect(parseMetricTreeNodes("string")).toEqual([]);
  });
});

describe("sepNamesFromTree", () => {
  it("takes folders as endpoints", () => {
    expect(sepNamesFromTree(parseMetricTreeNodes(tree.tierInventory))).toEqual([
      "/http/to2nd",
    ]);
  });

  it("excludes metric leaves that sit alongside endpoint folders", () => {
    const nodes = parseMetricTreeNodes(tree.endpointHttpTo2nd);
    expect(sepNamesFromTree(nodes)).toEqual(["Individual Nodes"]);
  });

  it("is case-insensitive about the folder type", () => {
    expect(sepNamesFromTree([{ name: "A", type: "FOLDER" }])).toEqual(["A"]);
  });
});

describe("matchServiceEndpoints", () => {
  const endpoints: ServiceEndpointRef[] = [
    { name: "/http/to2nd", tierName: "Inventory" },
    { name: "/http/to2nd", tierName: "FrontEnd" },
    { name: "/api/orders", tierName: "OrderProcessing" },
  ];

  it("prefers an exact match over substrings", () => {
    const hits = matchServiceEndpoints(
      [
        { name: "/api", tierName: "FrontEnd" },
        { name: "/api/orders", tierName: "FrontEnd" },
      ],
      "/api"
    );
    expect(hits).toEqual([{ name: "/api", tierName: "FrontEnd" }]);
  });

  it("matches case-insensitively", () => {
    expect(matchServiceEndpoints(endpoints, "/API/ORDERS")).toHaveLength(1);
  });

  it("returns every tier hosting the same endpoint name", () => {
    expect(matchServiceEndpoints(endpoints, "/http/to2nd")).toHaveLength(2);
  });

  it("narrows to one when a tier is supplied", () => {
    expect(
      matchServiceEndpoints(endpoints, "/http/to2nd", "Inventory")
    ).toEqual([{ name: "/http/to2nd", tierName: "Inventory" }]);
  });

  it("falls back to substring matching", () => {
    expect(matchServiceEndpoints(endpoints, "orders")).toEqual([
      { name: "/api/orders", tierName: "OrderProcessing" },
    ]);
  });

  it("returns nothing for a miss", () => {
    expect(matchServiceEndpoints(endpoints, "/nope")).toEqual([]);
  });
});

describe("describeEndpoints", () => {
  it("lists name and tier per line", () => {
    expect(
      describeEndpoints([{ name: "/a", tierName: "T1" }, { name: "/b", tierName: "T2" }])
    ).toBe("  - /a (tier: T1)\n  - /b (tier: T2)");
  });
});
