import { describe, it, expect } from "vitest";
import { truncateIfNeeded } from "../src/utils/formatting.js";
import { CHARACTER_LIMIT } from "../src/constants.js";

/** Builds an array whose serialized form far exceeds CHARACTER_LIMIT. */
function oversizedArray(count: number, padding = 200) {
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    name: `entity-${i}`,
    detail: "x".repeat(padding),
  }));
}

describe("truncateIfNeeded", () => {
  it("returns data unchanged when it fits the budget", () => {
    const data = [{ id: 1 }, { id: 2 }];
    expect(truncateIfNeeded(data)).toBe(JSON.stringify(data, null, 2));
  });

  it("keeps a payload that is many times over the limit within budget", () => {
    // ~10x over the limit — a single halving would still leave it ~5x over.
    const data = oversizedArray(2000);
    expect(JSON.stringify(data, null, 2).length).toBeGreaterThan(CHARACTER_LIMIT * 5);

    const result = truncateIfNeeded(data);
    expect(result.length).toBeLessThanOrEqual(CHARACTER_LIMIT);
  });

  it("reports how many items were kept out of the total", () => {
    const data = oversizedArray(2000);
    const result = truncateIfNeeded(data);

    const match = result.match(/Showing (\d+) of (\d+) items/);
    expect(match).not.toBeNull();

    const kept = Number(match![1]);
    const total = Number(match![2]);
    expect(total).toBe(2000);
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(total);
  });

  it("keeps the truncated array parseable as JSON", () => {
    const data = oversizedArray(2000);
    const result = truncateIfNeeded(data);

    const jsonPart = result.slice(0, result.indexOf("\n\n--- TRUNCATED"));
    const parsed = JSON.parse(jsonPart);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toEqual(data[0]);
  });

  it("keeps the maximum number of items that fit the budget", () => {
    const data = Array.from({ length: 5000 }, (_, i) => ({ id: i }));
    const result = truncateIfNeeded(data);
    const kept = Number(result.match(/Showing (\d+) of/)![1]);

    expect(result.length).toBeLessThanOrEqual(CHARACTER_LIMIT);

    // Maximality: one more item would not have fit.
    const oneMore = JSON.stringify(data.slice(0, kept + 1), null, 2).length;
    expect(oneMore).toBeGreaterThan(CHARACTER_LIMIT - 200);
  });

  it("scales the kept count to item size", () => {
    const small = Array.from({ length: 5000 }, (_, i) => ({ id: i }));
    const large = oversizedArray(5000, 500);

    const keptSmall = Number(truncateIfNeeded(small).match(/Showing (\d+) of/)![1]);
    const keptLarge = Number(truncateIfNeeded(large).match(/Showing (\d+) of/)![1]);

    expect(keptSmall).toBeGreaterThan(keptLarge);
  });

  it("falls back to string truncation for oversized non-array data", () => {
    const data = { blob: "y".repeat(CHARACTER_LIMIT * 2) };
    const result = truncateIfNeeded(data);

    expect(result).toContain("Response exceeded");
    expect(result.length).toBeLessThan(CHARACTER_LIMIT + 200);
  });

  it("falls back to string truncation when a single item exceeds the budget", () => {
    const data = [{ blob: "z".repeat(CHARACTER_LIMIT * 2) }];
    const result = truncateIfNeeded(data);
    expect(result).toContain("Response exceeded");
  });

  it("includes the caller's context hint in the truncation note", () => {
    const result = truncateIfNeeded(oversizedArray(2000), "Filter by tier.");
    expect(result).toContain("Filter by tier.");
  });

  it("handles an empty array", () => {
    expect(truncateIfNeeded([])).toBe("[]");
  });
});
