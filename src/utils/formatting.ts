/**
 * Response formatting utilities.
 * Helps create concise, readable responses that minimize token usage.
 */

import { CHARACTER_LIMIT } from "../constants.js";

/** Characters reserved for the truncation note appended after a truncated array. */
const TRUNCATION_NOTE_RESERVE = 200;

/**
 * Truncate a JSON response if it exceeds CHARACTER_LIMIT.
 * Returns the truncated string with a note about truncation.
 *
 * For arrays, the item count is reduced by binary search until the serialized
 * result fits the budget — a single halving is not enough when the payload is
 * many times over the limit.
 */
export function truncateIfNeeded(
  data: unknown,
  context?: string
): string {
  const json = JSON.stringify(data, null, 2);

  if (json.length <= CHARACTER_LIMIT) {
    return json;
  }

  // If it's an array, keep as many leading items as fit within the budget.
  if (Array.isArray(data)) {
    const kept = largestFittingPrefix(data);

    if (kept > 0) {
      const truncatedJson = JSON.stringify(data.slice(0, kept), null, 2);
      const note = `\n\n--- TRUNCATED: Showing ${kept} of ${data.length} items. Narrow the time range or add filters to see more.${context ? ` ${context}` : ""} ---`;
      return truncatedJson + note;
    }

    // Even a single item exceeds the budget — fall through to string truncation.
  }

  // For non-array data (or one oversized item), truncate the serialized string.
  const truncated = json.slice(0, CHARACTER_LIMIT);
  return (
    truncated +
    `\n\n--- TRUNCATED: Response exceeded ${CHARACTER_LIMIT} characters. Use filters to narrow results. ---`
  );
}

/**
 * Binary-search the largest N for which JSON.stringify(items.slice(0, N))
 * fits within CHARACTER_LIMIT. Returns 0 if not even one item fits.
 */
function largestFittingPrefix(items: readonly unknown[]): number {
  // Reserve room for the truncation note appended by the caller.
  const budget = CHARACTER_LIMIT - TRUNCATION_NOTE_RESERVE;

  let low = 0;
  let high = items.length;

  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (JSON.stringify(items.slice(0, mid), null, 2).length <= budget) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return low;
}

/**
 * Format a Unix timestamp (milliseconds) to a human-readable string.
 */
export function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}
