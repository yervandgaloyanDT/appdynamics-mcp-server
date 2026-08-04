/**
 * Bounded-concurrency helpers.
 *
 * Several tools fan out across every application or tier on the controller.
 * Unbounded Promise.all over those lists produces one simultaneous request per
 * entity, which trips controller rate limits (429) on large accounts.
 */

import { MAX_CONCURRENT_REQUESTS } from "../constants.js";

/**
 * Map over `items` with at most `limit` promises in flight at once.
 * Results preserve input order. Rejections propagate like Promise.all.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  limit: number = MAX_CONCURRENT_REQUESTS
): Promise<R[]> {
  if (items.length === 0) return [];

  const effectiveLimit = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  }

  await Promise.all(Array.from({ length: effectiveLimit }, () => worker()));
  return results;
}
