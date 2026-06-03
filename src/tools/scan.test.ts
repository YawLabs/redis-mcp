import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { accumulateScan, deriveMaxIterations, type ScanBatch } from "./scan.js";

/**
 * Build a fake SCAN source over a fixed key list, served in pages of `pageSize`.
 * Cursor is the next start index as a string; "0" means done (Redis convention).
 * This lets us exercise accumulateScan's loop control with zero I/O.
 */
function fakeScanner(allKeys: string[], pageSize: number): (cursor: string) => Promise<ScanBatch> {
  return async (cursor: string) => {
    const start = Number(cursor);
    const page = allKeys.slice(start, start + pageSize);
    const nextIndex = start + pageSize;
    const done = nextIndex >= allKeys.length;
    return { cursor: done ? "0" : String(nextIndex), keys: page };
  };
}

describe("accumulateScan: full traversal", () => {
  it("collects every key when under the cap and reports cursor 0, not truncated", async () => {
    const keys = Array.from({ length: 25 }, (_, i) => `k${i}`);
    const r = await accumulateScan("0", fakeScanner(keys, 10), { maxKeys: 1000, maxIterations: 100 });
    assert.equal(r.keys.length, 25);
    assert.deepEqual(r.keys, keys);
    assert.equal(r.cursor, "0");
    assert.equal(r.truncated, false);
    assert.equal(r.iterations, 3); // pages of 10: [0-9], [10-19], [20-24]
  });

  it("handles an empty keyspace in one iteration", async () => {
    const r = await accumulateScan("0", fakeScanner([], 10), { maxKeys: 1000, maxIterations: 100 });
    assert.deepEqual(r.keys, []);
    assert.equal(r.cursor, "0");
    assert.equal(r.truncated, false);
    assert.equal(r.iterations, 1);
  });
});

describe("accumulateScan: maxKeys cap", () => {
  it("stops at exactly maxKeys and reports a resumable cursor", async () => {
    const keys = Array.from({ length: 100 }, (_, i) => `k${i}`);
    const r = await accumulateScan("0", fakeScanner(keys, 10), { maxKeys: 25, maxIterations: 100 });
    assert.equal(r.keys.length, 25);
    assert.equal(r.truncated, true);
    assert.notEqual(r.cursor, "0", "a truncated scan must hand back a non-zero cursor to resume");
  });

  it("does not over-collect past the cap even mid-batch", async () => {
    const keys = Array.from({ length: 100 }, (_, i) => `k${i}`);
    // Cap of 23 lands inside the 3rd page of 10 -> last page contributes 3.
    const r = await accumulateScan("0", fakeScanner(keys, 10), { maxKeys: 23, maxIterations: 100 });
    assert.equal(r.keys.length, 23);
  });

  it("reports not-truncated when the cap is hit exactly as the keyspace ends", async () => {
    const keys = Array.from({ length: 20 }, (_, i) => `k${i}`);
    // maxKeys=20, pages of 10 -> 2nd page wraps cursor to "0" AND fills the cap.
    const r = await accumulateScan("0", fakeScanner(keys, 10), { maxKeys: 20, maxIterations: 100 });
    assert.equal(r.keys.length, 20);
    assert.equal(r.cursor, "0");
    assert.equal(r.truncated, false, "cap hit exactly at keyspace end is not a truncation");
  });
});

describe("accumulateScan: maxIterations cap", () => {
  it("stops after maxIterations with a resumable cursor when MATCH is selective", async () => {
    // 1000 keys, but the scanner returns empty pages (simulating a selective
    // MATCH that matches nothing in these batches). Cap iterations at 5.
    const emptyPages: (cursor: string) => Promise<ScanBatch> = async (cursor) => {
      const start = Number(cursor);
      const next = start + 10;
      // Never wraps to 0 within the iteration budget.
      return { cursor: String(next), keys: [] };
    };
    const r = await accumulateScan("0", emptyPages, { maxKeys: 100, maxIterations: 5 });
    assert.equal(r.keys.length, 0);
    assert.equal(r.iterations, 5);
    assert.equal(r.truncated, true);
    assert.notEqual(r.cursor, "0");
  });
});

describe("accumulateScan: dedup within a call", () => {
  it("removes duplicate keys SCAN may return when the keyspace resizes", async () => {
    // Scanner returns overlapping pages: [a,b], [b,c], [c,d], done.
    const pages: ScanBatch[] = [
      { cursor: "1", keys: ["a", "b"] },
      { cursor: "2", keys: ["b", "c"] },
      { cursor: "0", keys: ["c", "d"] },
    ];
    let i = 0;
    const r = await accumulateScan(
      "0",
      async () => {
        const p = pages[i] ?? { cursor: "0", keys: [] };
        i++;
        return p;
      },
      { maxKeys: 1000, maxIterations: 100 },
    );
    assert.deepEqual(r.keys, ["a", "b", "c", "d"], "duplicates removed, first-seen order preserved");
  });
});

describe("accumulateScan: resume from a non-zero cursor", () => {
  it("starts scanning from the provided cursor", async () => {
    const keys = Array.from({ length: 30 }, (_, i) => `k${i}`);
    // Resume from index 10.
    const r = await accumulateScan("10", fakeScanner(keys, 10), { maxKeys: 1000, maxIterations: 100 });
    assert.deepEqual(r.keys, keys.slice(10));
    assert.equal(r.cursor, "0");
  });
});

describe("deriveMaxIterations", () => {
  it("scales with maxKeys / scanCount and applies the 20x selectivity multiplier", () => {
    // 1000 keys / 100 count = 10 base * 20 = 200.
    assert.equal(deriveMaxIterations(1000, 100), 200);
  });

  it("enforces a floor of 50 iterations for tiny caps", () => {
    assert.equal(deriveMaxIterations(1, 100), 50);
    assert.equal(deriveMaxIterations(10, 1000), 50);
  });

  it("treats a zero/invalid scanCount as 1 to avoid divide-by-zero", () => {
    // base = ceil(100/1) = 100, *20 = 2000.
    assert.equal(deriveMaxIterations(100, 0), 2000);
  });
});
