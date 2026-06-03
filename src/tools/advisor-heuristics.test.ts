import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type EvictionFacts,
  type ForkLatencyFacts,
  findBigKeys,
  findEvictionPressure,
  findForkLatencyRisk,
  findMissingTtls,
  type SampledKey,
} from "./advisor-heuristics.js";

const key = (over: Partial<SampledKey>): SampledKey => ({
  key: "k",
  type: "string",
  memoryBytes: null,
  elements: null,
  ttl: -1,
  ...over,
});

describe("findBigKeys", () => {
  const t = { bigKeyBytes: 1_048_576, bigKeyElements: 5000 };

  it("flags a key over the byte threshold", () => {
    const f = findBigKeys([key({ key: "huge", memoryBytes: 2_000_000 })], t);
    assert.equal(f.length, 1);
    assert.match(f[0]!.message, /huge/);
    assert.equal(f[0]!.severity, "warn");
  });

  it("flags a collection over the element threshold even when memory is unknown", () => {
    const f = findBigKeys([key({ key: "biglist", type: "list", memoryBytes: null, elements: 9999 })], t);
    assert.equal(f.length, 1);
    assert.match(f[0]!.message, /9999 elements/);
  });

  it("escalates to critical at 10x the byte threshold", () => {
    const f = findBigKeys([key({ key: "massive", memoryBytes: 1_048_576 * 10 })], t);
    assert.equal(f[0]!.severity, "critical");
  });

  it("does not flag keys under both thresholds", () => {
    const f = findBigKeys([key({ memoryBytes: 1024, elements: 10 })], t);
    assert.deepEqual(f, []);
  });

  it("sorts findings largest-memory first", () => {
    const f = findBigKeys(
      [key({ key: "small", memoryBytes: 1_100_000 }), key({ key: "large", memoryBytes: 5_000_000 })],
      t,
    );
    assert.equal(f[0]!.detail?.key, "large");
    assert.equal(f[1]!.detail?.key, "small");
  });
});

describe("findMissingTtls", () => {
  it("flags when the no-TTL fraction meets the threshold", () => {
    const sample = [key({ ttl: -1 }), key({ ttl: -1 }), key({ ttl: 60 })]; // 2/3 = 0.67
    const f = findMissingTtls(sample, 0.5);
    assert.equal(f.length, 1);
    assert.match(f[0]!.message, /no TTL/);
    assert.equal(f[0]!.detail?.without_ttl, 2);
  });

  it("does not flag when under the threshold", () => {
    const sample = [key({ ttl: -1 }), key({ ttl: 60 }), key({ ttl: 60 })]; // 1/3 = 0.33
    assert.deepEqual(findMissingTtls(sample, 0.5), []);
  });

  it("escalates to warn at 90%+ no-TTL", () => {
    const sample = Array.from({ length: 10 }, (_, i) => key({ ttl: i === 0 ? 60 : -1 })); // 9/10
    assert.equal(findMissingTtls(sample, 0.5)[0]!.severity, "warn");
  });

  it("returns [] for an empty sample (no division by zero)", () => {
    assert.deepEqual(findMissingTtls([], 0.5), []);
  });
});

describe("findEvictionPressure", () => {
  const base: EvictionFacts = {
    maxmemoryBytes: null,
    usedMemoryBytes: null,
    maxmemoryPolicy: null,
    evictedKeys: null,
    hasKeysWithoutTtl: false,
  };

  it("flags high used/maxmemory ratio", () => {
    const f = findEvictionPressure({ ...base, maxmemoryBytes: 1000, usedMemoryBytes: 850 }, 0.8);
    assert.equal(f.length, 1);
    assert.match(f[0]!.message, /maxmemory/);
  });

  it("escalates to critical at >=95% used", () => {
    const f = findEvictionPressure({ ...base, maxmemoryBytes: 1000, usedMemoryBytes: 960 }, 0.8);
    assert.equal(f[0]!.severity, "critical");
  });

  it("flags active evictions", () => {
    const f = findEvictionPressure({ ...base, evictedKeys: 42 }, 0.8);
    assert.equal(f.length, 1);
    assert.match(f[0]!.message, /evicted/);
  });

  it("flags the noeviction + no-TTL footgun", () => {
    const f = findEvictionPressure(
      { ...base, maxmemoryBytes: 1000, usedMemoryBytes: 100, maxmemoryPolicy: "noeviction", hasKeysWithoutTtl: true },
      0.8,
    );
    assert.equal(f.length, 1);
    assert.match(f[0]!.message, /noeviction/);
    assert.match(f[0]!.message, /OOM/);
  });

  it("does NOT flag noeviction when every key has a TTL", () => {
    const f = findEvictionPressure(
      { ...base, maxmemoryBytes: 1000, usedMemoryBytes: 100, maxmemoryPolicy: "noeviction", hasKeysWithoutTtl: false },
      0.8,
    );
    assert.deepEqual(f, []);
  });

  it("returns nothing when maxmemory is unset (0 = unlimited) and no evictions", () => {
    const f = findEvictionPressure({ ...base, maxmemoryBytes: 0, usedMemoryBytes: 9_999_999 }, 0.8);
    assert.deepEqual(f, []);
  });
});

describe("findForkLatencyRisk", () => {
  const base: ForkLatencyFacts = {
    latestForkUsec: null,
    usedMemoryBytes: null,
    aofEnabled: false,
    rdbBgsaveInProgress: false,
    rdbLastBgsaveStatus: null,
  };

  it("flags a long last fork (>= threshold)", () => {
    const f = findForkLatencyRisk({ ...base, latestForkUsec: 150_000 }, 100_000, 1_073_741_824);
    assert.ok(f.some((x) => /last fork/.test(x.message)));
  });

  it("escalates fork time to critical at 5x threshold", () => {
    const f = findForkLatencyRisk({ ...base, latestForkUsec: 600_000 }, 100_000, 1_073_741_824);
    const forkFinding = f.find((x) => /last fork/.test(x.message));
    assert.equal(forkFinding!.severity, "critical");
  });

  it("flags large dataset + active persistence as info", () => {
    const f = findForkLatencyRisk(
      { ...base, usedMemoryBytes: 2_000_000_000, aofEnabled: true, rdbLastBgsaveStatus: "ok" },
      100_000,
      1_073_741_824,
    );
    assert.ok(f.some((x) => x.severity === "info" && /Dataset is large/.test(x.message)));
  });

  it("flags a failed last bgsave as critical", () => {
    const f = findForkLatencyRisk({ ...base, rdbLastBgsaveStatus: "err" }, 100_000, 1_073_741_824);
    const failed = f.find((x) => /background save failed/.test(x.message));
    assert.equal(failed!.severity, "critical");
  });

  it("returns nothing on a small, fast, healthy instance", () => {
    const f = findForkLatencyRisk(
      { ...base, latestForkUsec: 500, usedMemoryBytes: 10_000_000, rdbLastBgsaveStatus: "ok" },
      100_000,
      1_073_741_824,
    );
    assert.deepEqual(f, []);
  });
});
