/**
 * Pure helpers for locating service endpoints in the AppDynamics metric tree.
 *
 * Service endpoints have no usable configuration endpoint on SaaS controllers:
 *   GET /rest/applications/{app}/service-endpoints            → 400 Unsupported URI
 *   GET /rest/applications/{app}/tiers/{tier}/service-endpoints → 400 Unsupported URI
 *   POST /restui/serviceEndpoint/*                             → 404
 *
 * They are, however, fully addressable through the metric tree, which is laid
 * out tier-first:
 *
 *   Service Endpoints
 *     └── <tier name>              (folder)
 *          └── <service endpoint>  (folder)
 *               ├── Average Response Time (ms)   (leaf)
 *               ├── Calls per Minute             (leaf)
 *               ├── Errors per Minute            (leaf)
 *               └── Individual Nodes             (folder)
 *
 * Verified live: `Service Endpoints|Inventory|/http/to2nd|Calls per Minute`
 * resolves and returns data. The tier segment is required — neither
 * `Service Endpoints|<name>|<metric>` nor a numeric id in place of the name
 * resolves to anything.
 *
 * No I/O here: everything in this module is pure so it can be unit-tested
 * against captured tree responses.
 */

/** Root folder of the service endpoint subtree. */
export const SEP_ROOT = "Service Endpoints";

/** Leaf metrics reported for every service endpoint. */
export const SEP_METRICS = [
  "Average Response Time (ms)",
  "Calls per Minute",
  "Errors per Minute",
] as const;

/** A node as returned by GET /rest/applications/{app}/metrics. */
export interface MetricTreeNode {
  name: string;
  type: string;
}

/** A service endpoint located in the metric tree. */
export interface ServiceEndpointRef {
  name: string;
  tierName: string;
}

/**
 * Metric-path segments are pipe-delimited, so a name containing a pipe cannot
 * be addressed unambiguously. Such names are rejected rather than silently
 * producing a path that resolves to the wrong entity (or to nothing).
 */
function assertAddressable(segment: string, label: string): void {
  if (segment.includes("|")) {
    throw new Error(
      `${label} "${segment}" contains a "|", which is the metric-path separator and cannot be escaped. Query this metric through appd_get_metric_data with an explicit path instead.`
    );
  }
}

/** Path of a tier's service endpoint folder. */
export function sepTierPath(tierName: string): string {
  assertAddressable(tierName, "Tier name");
  return `${SEP_ROOT}|${tierName}`;
}

/** Path of a single service endpoint folder. */
export function sepPath(tierName: string, sepName: string): string {
  assertAddressable(sepName, "Service endpoint name");
  return `${sepTierPath(tierName)}|${sepName}`;
}

/** Path of one metric leaf beneath a service endpoint. */
export function sepMetricPath(
  tierName: string,
  sepName: string,
  metric: string
): string {
  return `${sepPath(tierName, sepName)}|${metric}`;
}

/**
 * Coerce a metric tree response into nodes, tolerating the shapes the
 * controller has been observed to return (array, or an object wrapping one).
 */
export function parseMetricTreeNodes(data: unknown): MetricTreeNode[] {
  const raw = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data["metricItems"])
      ? data["metricItems"]
      : [];

  const nodes: MetricTreeNode[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const name = item["name"];
    if (typeof name !== "string" || name.length === 0) continue;
    const type = typeof item["type"] === "string" ? item["type"] : "";
    nodes.push({ name, type });
  }
  return nodes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Service endpoints are the *folders* directly under a tier. Leaves at this
 * level would be tier-wide metrics, not endpoints.
 */
export function sepNamesFromTree(nodes: readonly MetricTreeNode[]): string[] {
  return nodes
    .filter((n) => n.type.toLowerCase() === "folder")
    .map((n) => n.name);
}

/**
 * Find the service endpoints matching a user-supplied name.
 *
 * Exact (case-insensitive) matches win outright; otherwise substring matches
 * are returned so the caller can report an unambiguous miss or a shortlist.
 * Mirrors resolveAppId's behaviour so name handling feels the same everywhere.
 */
export function matchServiceEndpoints(
  endpoints: readonly ServiceEndpointRef[],
  query: string,
  tierFilter?: string | undefined
): ServiceEndpointRef[] {
  const wanted = query.toLowerCase().trim();
  const tier = tierFilter?.toLowerCase().trim();

  const inScope = tier
    ? endpoints.filter((e) => e.tierName.toLowerCase() === tier)
    : endpoints;

  const exact = inScope.filter((e) => e.name.toLowerCase() === wanted);
  if (exact.length > 0) return exact;

  return inScope.filter((e) => e.name.toLowerCase().includes(wanted));
}

/**
 * Build the human-readable list used in "which one did you mean?" errors.
 */
export function describeEndpoints(
  endpoints: readonly ServiceEndpointRef[]
): string {
  return endpoints.map((e) => `  - ${e.name} (tier: ${e.tierName})`).join("\n");
}
