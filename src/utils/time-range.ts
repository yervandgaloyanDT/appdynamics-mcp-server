/**
 * Shared time-range handling for AppDynamics REST API calls.
 *
 * The AppDynamics REST API accepts four time-range-type values, each requiring
 * a different combination of start-time / end-time / duration-in-mins:
 *
 *   BEFORE_NOW     duration-in-mins
 *   BEFORE_TIME    duration-in-mins + end-time
 *   AFTER_TIME     duration-in-mins + start-time
 *   BETWEEN_TIMES  start-time + end-time
 *
 * Tools expose `durationInMins`, `startTime`, and `endTime`; this module picks
 * the correct time-range-type and emits the matching query parameters.
 */

import { z } from "zod";

/** Epoch ms for 2000-01-01. Timestamps before this are treated as a unit mistake. */
const MIN_VALID_MS = 946_684_800_000;

/** Epoch ms for 2100-01-01. Timestamps after this are treated as a unit mistake. */
const MAX_VALID_MS = 4_102_444_800_000;

/**
 * Below this value a numeric timestamp cannot plausibly be epoch milliseconds
 * (it would be 1973), so it is interpreted as epoch seconds instead. This makes
 * a caller passing Unix seconds fail loudly-correct rather than silently
 * querying 1970 and returning an empty result set.
 */
const SECONDS_THRESHOLD = 100_000_000_000;

/** Input schema fragment — spread into a tool's inputSchema alongside its own fields. */
export const TimeRangeSchema = {
  durationInMins: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Length of the time window in minutes. Used alone this means 'the last N minutes'. " +
        "Combined with startTime or endTime it anchors the window to that point."
    ),
  startTime: z
    .union([z.string(), z.number()])
    .optional()
    .describe(
      "Start of the time window — ISO 8601 string (e.g. '2026-08-03T14:00:00Z') or epoch milliseconds. " +
        "Combine with endTime for an exact window, or with durationInMins for N minutes after this point."
    ),
  endTime: z
    .union([z.string(), z.number()])
    .optional()
    .describe(
      "End of the time window — ISO 8601 string (e.g. '2026-08-03T15:00:00Z') or epoch milliseconds. " +
        "Combine with startTime for an exact window, or with durationInMins for N minutes before this point."
    ),
};

export interface TimeRangeInput {
  durationInMins?: number | undefined;
  startTime?: string | number | undefined;
  endTime?: string | number | undefined;
}

export interface ResolvedTimeRange {
  /** Query parameters to spread into an appdGet call. */
  params: Record<string, string | number>;
  /** Human-readable description, e.g. "Last 60 minutes". */
  description: string;
  /** Window start as epoch ms. */
  startMs: number;
  /** Window end as epoch ms. */
  endMs: number;
  /** Window length in minutes. */
  durationMins: number;
}

/**
 * Parse an ISO 8601 string or epoch timestamp into epoch milliseconds.
 * Throws a descriptive Error the caller can surface directly to the user.
 */
export function parseTimestamp(value: string | number, label: string): number {
  let ms: number;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} must be a finite number of epoch milliseconds.`);
    }
    // Interpret plausible epoch-seconds values as seconds.
    ms = value < SECONDS_THRESHOLD ? value * 1000 : value;
  } else {
    const trimmed = value.trim();
    if (trimmed === "") {
      throw new Error(`${label} must not be empty.`);
    }
    // A bare numeric string is an epoch timestamp, not a date string.
    if (/^\d+$/.test(trimmed)) {
      return parseTimestamp(Number(trimmed), label);
    }
    ms = Date.parse(trimmed);
    if (Number.isNaN(ms)) {
      throw new Error(
        `${label} is not a valid timestamp: "${value}". ` +
          `Use ISO 8601 (e.g. '2026-08-03T14:00:00Z') or epoch milliseconds.`
      );
    }
  }

  ms = Math.round(ms);

  if (ms < MIN_VALID_MS || ms > MAX_VALID_MS) {
    throw new Error(
      `${label} resolves to ${new Date(ms).toISOString()}, which is outside the supported range ` +
        `(2000-2100). Check the units — epoch values must be seconds or milliseconds.`
    );
  }

  return ms;
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Resolve tool time-range inputs into AppDynamics query parameters.
 *
 * Accepted combinations:
 *   (nothing)                → BEFORE_NOW with the tool's default duration
 *   durationInMins           → BEFORE_NOW
 *   endTime [+ duration]     → BEFORE_TIME
 *   startTime [+ duration]   → AFTER_TIME
 *   startTime + endTime      → BETWEEN_TIMES
 *
 * Throws on contradictory input (all three supplied) or an inverted window.
 */
export function resolveTimeRange(
  input: TimeRangeInput,
  defaultDurationMins: number
): ResolvedTimeRange {
  const { durationInMins } = input;

  const startMs =
    input.startTime !== undefined
      ? parseTimestamp(input.startTime, "startTime")
      : undefined;
  const endMs =
    input.endTime !== undefined
      ? parseTimestamp(input.endTime, "endTime")
      : undefined;

  // Exact window
  if (startMs !== undefined && endMs !== undefined) {
    if (durationInMins !== undefined) {
      throw new Error(
        "Provide either durationInMins or both startTime and endTime — not all three. " +
          "With startTime and endTime the duration is implied by the window."
      );
    }
    if (endMs <= startMs) {
      throw new Error(
        `endTime (${isoOf(endMs)}) must be after startTime (${isoOf(startMs)}).`
      );
    }
    const durationMins = Math.max(1, Math.round((endMs - startMs) / 60_000));
    return {
      params: {
        "time-range-type": "BETWEEN_TIMES",
        "start-time": startMs,
        "end-time": endMs,
      },
      description: `${isoOf(startMs)} → ${isoOf(endMs)} (${durationMins} minutes)`,
      startMs,
      endMs,
      durationMins,
    };
  }

  const durationMins = durationInMins ?? defaultDurationMins;
  const windowMs = durationMins * 60_000;

  // N minutes before a fixed point
  if (endMs !== undefined) {
    return {
      params: {
        "time-range-type": "BEFORE_TIME",
        "duration-in-mins": durationMins,
        "end-time": endMs,
      },
      description: `${durationMins} minutes before ${isoOf(endMs)}`,
      startMs: endMs - windowMs,
      endMs,
      durationMins,
    };
  }

  // N minutes after a fixed point
  if (startMs !== undefined) {
    return {
      params: {
        "time-range-type": "AFTER_TIME",
        "duration-in-mins": durationMins,
        "start-time": startMs,
      },
      description: `${durationMins} minutes after ${isoOf(startMs)}`,
      startMs,
      endMs: startMs + windowMs,
      durationMins,
    };
  }

  // Rolling window ending now
  const now = Date.now();
  return {
    params: {
      "time-range-type": "BEFORE_NOW",
      "duration-in-mins": durationMins,
    },
    description: `Last ${durationMins} minutes`,
    startMs: now - windowMs,
    endMs: now,
    durationMins,
  };
}

/**
 * Build the equivalent window immediately preceding a resolved range.
 * Used for baseline comparison in root cause analysis.
 */
export function precedingWindow(range: ResolvedTimeRange): ResolvedTimeRange {
  const endMs = range.startMs;
  const durationMins = range.durationMins;
  return {
    params: {
      "time-range-type": "BEFORE_TIME",
      "duration-in-mins": durationMins,
      "end-time": endMs,
    },
    description: `${durationMins} minutes before ${isoOf(endMs)}`,
    startMs: endMs - durationMins * 60_000,
    endMs,
    durationMins,
  };
}
