/**
 * Cursor-based SCAN paging. The iteration-control logic (when to stop, how to
 * apply the key cap, how to bound iterations) is PURE and lives in
 * `accumulateScan`, which takes an injected "fetch one batch" function -- so it
 * is unit-testable without a live Redis by passing a fake batch source.
 *
 * Why SCAN and not KEYS: KEYS is O(N) over the whole keyspace and blocks
 * Redis's single-threaded event loop for the entire scan. On a production
 * instance with millions of keys that is a self-inflicted denial of service.
 * SCAN returns a cursor and a small batch per round-trip, yielding the event
 * loop between batches. This is the load-bearing safety choice of this server.
 */

/** One SCAN round-trip result: the next cursor ("0" means done) and its keys. */
export interface ScanBatch {
  cursor: string;
  keys: string[];
}

export interface ScanPageOptions {
  /** Hard cap on keys returned across all iterations. */
  maxKeys: number;
  /**
   * Hard cap on SCAN round-trips, independent of maxKeys. A keyspace with a
   * very selective MATCH can return empty batches for many iterations before
   * the cursor wraps; without an iteration cap a single tool call could issue
   * thousands of round-trips. Stops early and reports a non-zero cursor so the
   * caller can resume.
   */
  maxIterations: number;
}

export interface ScanPageResult {
  keys: string[];
  /**
   * The cursor to resume from. "0" means the full keyspace was scanned (no
   * more keys). A non-"0" cursor means we stopped early (hit maxKeys or
   * maxIterations) -- pass it back as the starting cursor to continue.
   */
  cursor: string;
  /** True when we stopped before exhausting the keyspace. */
  truncated: boolean;
  /** Number of SCAN round-trips performed. */
  iterations: number;
}

/**
 * Drive SCAN to completion or until a cap trips, accumulating keys.
 *
 * `fetchBatch(cursor)` performs one SCAN round-trip and returns the next cursor
 * + that batch's keys. It is injected so the loop is pure and testable: tests
 * pass a function backed by a fixed array; production passes one backed by
 * `client.scan`.
 *
 * Stopping rules, in priority order:
 *   1. Reached `maxKeys` -> truncate the last batch to exactly maxKeys, report
 *      the cursor of the batch we stopped on (so a resume re-scans that batch's
 *      tail; SCAN guarantees no key present for the whole scan is missed, and
 *      a key may appear twice across a resumed scan -- the caller dedupes).
 *   2. Cursor returned "0" -> keyspace exhausted, cursor "0", not truncated.
 *   3. Reached `maxIterations` -> stop, report the live cursor, truncated.
 *
 * Within a single call we dedupe keys (SCAN can return the same key more than
 * once if the keyspace is resized mid-scan). The dedupe preserves first-seen
 * order.
 */
export async function accumulateScan(
  startCursor: string,
  fetchBatch: (cursor: string) => Promise<ScanBatch>,
  opts: ScanPageOptions,
): Promise<ScanPageResult> {
  const seen = new Set<string>();
  const keys: string[] = [];
  let cursor = startCursor;
  let iterations = 0;

  while (true) {
    const batch = await fetchBatch(cursor);
    iterations++;
    cursor = batch.cursor;

    for (const k of batch.keys) {
      if (keys.length >= opts.maxKeys) break;
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }

    // Cap hit: stop and report the cursor we just consumed so the caller can
    // resume. truncated=true even if the cursor happens to be "0" would be
    // wrong, so check exhaustion first below.
    if (keys.length >= opts.maxKeys) {
      // If this batch also wrapped the cursor to "0", the keyspace is actually
      // exhausted at exactly the cap -- nothing more to fetch.
      return { keys, cursor, truncated: cursor !== "0", iterations };
    }

    // Keyspace exhausted.
    if (cursor === "0") {
      return { keys, cursor: "0", truncated: false, iterations };
    }

    // Iteration cap: stop early with a resumable cursor.
    if (iterations >= opts.maxIterations) {
      return { keys, cursor, truncated: true, iterations };
    }
  }
}

/**
 * Derive the SCAN iteration cap from the key cap and the per-iteration COUNT
 * hint. We allow enough round-trips to plausibly collect `maxKeys` even when
 * MATCH is selective (few matches per batch), with a generous multiplier, but
 * still bound the total so a pathological MATCH can't spin forever. Pure and
 * exported for unit testing.
 *
 * The 20x multiplier: with a selective MATCH, many batches return zero matching
 * keys, so collecting maxKeys can take far more than maxKeys/scanCount
 * iterations. 20x covers a MATCH that hits ~5% of scanned keys while still
 * capping a never-matching pattern at a bounded round-trip count.
 */
export function deriveMaxIterations(maxKeys: number, scanCount: number): number {
  const perIterFloor = Math.max(1, scanCount);
  const base = Math.ceil(maxKeys / perIterFloor);
  return Math.max(50, base * 20);
}
