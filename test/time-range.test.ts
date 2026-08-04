import { describe, it, expect } from "vitest";
import {
  resolveTimeRange,
  parseTimestamp,
  precedingWindow,
} from "../src/utils/time-range.js";

const T14 = Date.parse("2026-08-03T14:00:00Z");
const T15 = Date.parse("2026-08-03T15:00:00Z");

describe("parseTimestamp", () => {
  it("parses ISO 8601 strings", () => {
    expect(parseTimestamp("2026-08-03T14:00:00Z", "startTime")).toBe(T14);
  });

  it("accepts epoch milliseconds", () => {
    expect(parseTimestamp(T14, "startTime")).toBe(T14);
  });

  it("interprets plausible epoch-seconds values as seconds", () => {
    expect(parseTimestamp(T14 / 1000, "startTime")).toBe(T14);
  });

  it("parses bare numeric strings as epoch values", () => {
    expect(parseTimestamp(String(T14), "startTime")).toBe(T14);
    expect(parseTimestamp(String(T14 / 1000), "startTime")).toBe(T14);
  });

  it("rejects unparseable strings with the field name", () => {
    expect(() => parseTimestamp("last tuesday", "endTime")).toThrow(/endTime/);
    expect(() => parseTimestamp("last tuesday", "endTime")).toThrow(/ISO 8601/);
  });

  it("rejects empty strings", () => {
    expect(() => parseTimestamp("   ", "startTime")).toThrow(/must not be empty/);
  });

  it("rejects timestamps outside the 2000-2100 range", () => {
    expect(() => parseTimestamp(1000, "startTime")).toThrow(/outside the supported range/);
    expect(() => parseTimestamp("1980-01-01T00:00:00Z", "startTime")).toThrow(
      /outside the supported range/
    );
  });

  it("rejects non-finite numbers", () => {
    expect(() => parseTimestamp(Number.NaN, "startTime")).toThrow(/finite/);
    expect(() => parseTimestamp(Number.POSITIVE_INFINITY, "startTime")).toThrow(/finite/);
  });
});

describe("resolveTimeRange", () => {
  it("defaults to BEFORE_NOW with the tool's default duration", () => {
    const range = resolveTimeRange({}, 60);
    expect(range.params).toEqual({
      "time-range-type": "BEFORE_NOW",
      "duration-in-mins": 60,
    });
    expect(range.description).toBe("Last 60 minutes");
    expect(range.durationMins).toBe(60);
  });

  it("uses BEFORE_NOW with an explicit duration", () => {
    const range = resolveTimeRange({ durationInMins: 15 }, 60);
    expect(range.params).toEqual({
      "time-range-type": "BEFORE_NOW",
      "duration-in-mins": 15,
    });
  });

  it("uses BETWEEN_TIMES for an exact window", () => {
    const range = resolveTimeRange({ startTime: T14, endTime: T15 }, 60);
    expect(range.params).toEqual({
      "time-range-type": "BETWEEN_TIMES",
      "start-time": T14,
      "end-time": T15,
    });
    expect(range.durationMins).toBe(60);
    expect(range.startMs).toBe(T14);
    expect(range.endMs).toBe(T15);
  });

  it("accepts ISO strings for an exact window", () => {
    const range = resolveTimeRange(
      { startTime: "2026-08-03T14:00:00Z", endTime: "2026-08-03T15:00:00Z" },
      60
    );
    expect(range.params["time-range-type"]).toBe("BETWEEN_TIMES");
    expect(range.params["start-time"]).toBe(T14);
  });

  it("uses BEFORE_TIME when only endTime is given", () => {
    const range = resolveTimeRange({ endTime: T15, durationInMins: 30 }, 60);
    expect(range.params).toEqual({
      "time-range-type": "BEFORE_TIME",
      "duration-in-mins": 30,
      "end-time": T15,
    });
    expect(range.startMs).toBe(T15 - 30 * 60_000);
    expect(range.endMs).toBe(T15);
  });

  it("uses AFTER_TIME when only startTime is given", () => {
    const range = resolveTimeRange({ startTime: T14, durationInMins: 30 }, 60);
    expect(range.params).toEqual({
      "time-range-type": "AFTER_TIME",
      "duration-in-mins": 30,
      "start-time": T14,
    });
    expect(range.endMs).toBe(T14 + 30 * 60_000);
  });

  it("falls back to the default duration when anchored by one endpoint only", () => {
    const range = resolveTimeRange({ endTime: T15 }, 45);
    expect(range.params["duration-in-mins"]).toBe(45);
  });

  it("rejects an inverted window", () => {
    expect(() => resolveTimeRange({ startTime: T15, endTime: T14 }, 60)).toThrow(
      /must be after startTime/
    );
  });

  it("rejects a zero-length window", () => {
    expect(() => resolveTimeRange({ startTime: T14, endTime: T14 }, 60)).toThrow(
      /must be after startTime/
    );
  });

  it("rejects contradictory input (duration + both endpoints)", () => {
    expect(() =>
      resolveTimeRange({ startTime: T14, endTime: T15, durationInMins: 30 }, 60)
    ).toThrow(/not all three/);
  });

  it("never emits undefined parameter values", () => {
    for (const input of [
      {},
      { durationInMins: 10 },
      { startTime: T14, endTime: T15 },
      { endTime: T15 },
      { startTime: T14 },
    ]) {
      const range = resolveTimeRange(input, 60);
      for (const value of Object.values(range.params)) {
        expect(value).toBeDefined();
      }
    }
  });
});

describe("precedingWindow", () => {
  it("returns the equivalent window immediately before the given range", () => {
    const range = resolveTimeRange({ startTime: T14, endTime: T15 }, 60);
    const baseline = precedingWindow(range);

    expect(baseline.params).toEqual({
      "time-range-type": "BEFORE_TIME",
      "duration-in-mins": 60,
      "end-time": T14,
    });
    expect(baseline.endMs).toBe(range.startMs);
    expect(baseline.durationMins).toBe(range.durationMins);
  });

  it("does not overlap the original window", () => {
    const range = resolveTimeRange({ durationInMins: 30 }, 60);
    const baseline = precedingWindow(range);
    expect(baseline.endMs).toBeLessThanOrEqual(range.startMs);
  });
});
