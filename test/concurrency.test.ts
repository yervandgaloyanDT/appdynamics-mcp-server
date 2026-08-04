import { describe, it, expect } from "vitest";
import { mapWithConcurrency } from "../src/utils/concurrency.js";

const tick = () => new Promise((r) => setTimeout(r, 1));

describe("mapWithConcurrency", () => {
  it("preserves input order regardless of completion order", async () => {
    const items = [50, 10, 30, 5, 20];
    const results = await mapWithConcurrency(items, async (ms) => {
      await new Promise((r) => setTimeout(r, ms / 10));
      return ms;
    });
    expect(results).toEqual(items);
  });

  it("passes the index to the mapper", async () => {
    const results = await mapWithConcurrency(["a", "b", "c"], async (item, i) => `${i}:${item}`);
    expect(results).toEqual(["0:a", "1:b", "2:c"]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency(
      Array.from({ length: 50 }, (_, i) => i),
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await tick();
        inFlight--;
      },
      4
    );

    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // actually ran in parallel
  });

  it("returns an empty array for empty input without invoking the mapper", async () => {
    let called = false;
    const results = await mapWithConcurrency([], async () => {
      called = true;
      return 1;
    });
    expect(results).toEqual([]);
    expect(called).toBe(false);
  });

  it("does not spawn more workers than items", async () => {
    let peak = 0;
    let inFlight = 0;

    await mapWithConcurrency(
      [1, 2],
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await tick();
        inFlight--;
      },
      10
    );

    expect(peak).toBeLessThanOrEqual(2);
  });

  it("propagates rejections", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      })
    ).rejects.toThrow("boom");
  });

  it("processes every item", async () => {
    const seen = new Set<number>();
    const items = Array.from({ length: 100 }, (_, i) => i);
    await mapWithConcurrency(items, async (n) => {
      await tick();
      seen.add(n);
    });
    expect(seen.size).toBe(100);
  });
});
