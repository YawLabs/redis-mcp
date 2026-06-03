/**
 * LIVE-Redis integration tests for redis_advisor.
 *
 * Covers the io-boundary the unit suite (advisor-heuristics) cannot reach:
 *   - the SCAN-sampling loop that gathers up to sampleSize keys (never KEYS)
 *   - probeKey: per-key type/ttl/memory pipeline + the type-specific element
 *     count round-trip (llen/scard/zcard/hlen/xlen)
 *   - sampleSize:0 short-circuits key sampling (sampled_keys === 0)
 *   - the assembled response shape (summary counts + four finding categories)
 *
 * The pure threshold logic lives in advisor-heuristics.test-style unit tests;
 * here we prove the live sampling feeds those heuristics real facts.
 *
 * Run via `npm run test:integration` with REDIS_URL set; skips otherwise.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { shutdown } from "../api.js";
import { advisorTools } from "./advisor.js";
import {
  cleanupPrefix,
  closeSeedClient,
  getSeedClient,
  HAVE_REDIS,
  skipReason,
  supportsMemoryUsage,
} from "./integration-harness.js";

const PREFIX = "redis_mcp_it_adv:";
const redis_advisor = advisorTools.find((t) => t.name === "redis_advisor")!;

type R = { ok: boolean; data?: any; error?: string };

let memUsage = false;

describe("integration: redis_advisor (live Redis)", { skip: skipReason() }, () => {
  before(async () => {
    if (!HAVE_REDIS) return;
    const seed = getSeedClient();
    await cleanupPrefix(seed, PREFIX);
    memUsage = await supportsMemoryUsage(seed);

    // Seed a spread of types so probeKey exercises every element-count branch.
    await seed.set(`${PREFIX}str`, "x");
    await seed.rpush(`${PREFIX}list`, "a", "b", "c");
    await seed.sadd(`${PREFIX}set`, "m1", "m2");
    await seed.zadd(`${PREFIX}zset`, 1, "z1", 2, "z2", 3, "z3", 4, "z4");
    // Single-pair HSET so the seed works on pre-4.0 servers too (the advisor
    // only reads via HLEN; the seeding shape is incidental).
    await seed.hset(`${PREFIX}hash`, "f", "v");
    // One key WITH a TTL and several WITHOUT, so missing-ttl sampling has signal.
    await seed.set(`${PREFIX}ttlkey`, "x", "EX", 1000);
    for (let i = 0; i < 5; i++) await seed.set(`${PREFIX}nottl${i}`, "x");
  });

  after(async () => {
    if (!HAVE_REDIS) return;
    try {
      await cleanupPrefix(getSeedClient(), PREFIX);
    } finally {
      await closeSeedClient();
      await shutdown();
    }
  });

  it("SCAN-samples the keyspace and returns the assembled advisor shape", async () => {
    const r = (await redis_advisor.handler({
      sampleSize: 5000,
      bigKeyBytes: 1_048_576,
      bigKeyElements: 5000,
      missingTtlFraction: 0.5,
    })) as R;
    assert.equal(r.ok, true, r.error);
    const d = r.data;

    // The SCAN loop sampled the keys we seeded (at least the 12 PREFIX keys;
    // the instance may hold others, so assert a lower bound).
    assert.ok(typeof d.sampled_keys === "number" && d.sampled_keys >= 12, `sampled_keys=${d.sampled_keys}`);

    // four finding categories present
    assert.ok(Array.isArray(d.big_keys));
    assert.ok(Array.isArray(d.missing_ttls));
    assert.ok(Array.isArray(d.eviction_pressure));
    assert.ok(Array.isArray(d.fork_latency_risk));

    // summary counts are non-negative integers
    for (const sev of ["critical", "warn", "info"] as const) {
      assert.ok(Number.isInteger(d.summary[sev]) && d.summary[sev] >= 0);
    }
  });

  it("probeKey: a low big-key threshold flags a real sampled key with type+memory detail", async (t) => {
    if (!memUsage) {
      t.skip("server has no MEMORY USAGE -- probeKey memoryBytes is null, big-key-by-bytes cannot trigger");
      return;
    }
    // bigKeyBytes:1 forces every probed key (which has a positive MEMORY USAGE)
    // to be flagged -> proves probeKey actually fetched memoryBytes from the live
    // pipeline and findBigKeys received it.
    const r = (await redis_advisor.handler({
      sampleSize: 5000,
      bigKeyBytes: 1,
      bigKeyElements: 5000,
      missingTtlFraction: 0.5,
    })) as R;
    assert.equal(r.ok, true, r.error);
    assert.ok(r.data.big_keys.length > 0, "every key >= 1 byte should be flagged");
    const f = r.data.big_keys[0];
    assert.ok(typeof f.detail.memory_bytes === "number" && f.detail.memory_bytes > 0);
    assert.ok(typeof f.detail.type === "string");
  });

  it("probeKey: a low element threshold flags the zset by its live ZCARD", async () => {
    // bigKeyElements:2 -> the 4-member zset (and 3-member list) exceed it. This
    // proves probeKey's type-specific element-count round-trip ran (zcard/llen),
    // independent of MEMORY USAGE support.
    const r = (await redis_advisor.handler({
      sampleSize: 5000,
      bigKeyBytes: 1_000_000_000,
      bigKeyElements: 2,
      missingTtlFraction: 0.5,
    })) as R;
    assert.equal(r.ok, true, r.error);
    const flaggedKeys = r.data.big_keys.map((f: any) => f.detail.key as string);
    assert.ok(
      flaggedKeys.includes(`${PREFIX}zset`),
      `expected the 4-element zset to be flagged by element count; flagged=${JSON.stringify(flaggedKeys)}`,
    );
    const zsetFinding = r.data.big_keys.find((f: any) => f.detail.key === `${PREFIX}zset`);
    assert.equal(zsetFinding.detail.elements, 4, "ZCARD-derived element count");
  });

  it("sampleSize:0 short-circuits key sampling (sampled_keys === 0) but still returns INFO-based findings", async () => {
    const r = (await redis_advisor.handler({
      sampleSize: 0,
      bigKeyBytes: 1_048_576,
      bigKeyElements: 5000,
      missingTtlFraction: 0.5,
    })) as R;
    assert.equal(r.ok, true, r.error);
    assert.equal(r.data.sampled_keys, 0, "no SCAN performed");
    assert.deepEqual(r.data.big_keys, [], "no sample -> no big-key findings");
    assert.deepEqual(r.data.missing_ttls, [], "no sample -> no missing-ttl findings");
    // eviction / fork findings are INFO-derived and independent of sampling;
    // they remain arrays (content depends on the instance config).
    assert.ok(Array.isArray(r.data.eviction_pressure));
    assert.ok(Array.isArray(r.data.fork_latency_risk));
  });
});
