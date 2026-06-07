/**
 * LIVE-Redis integration tests for the keyspace tools (redis_get, redis_key_info).
 *
 * Covers the io-boundary handlers that the unit suite cannot reach:
 *   - redis_get type-dispatch over string/hash/list/set/zset/stream
 *   - the SSCAN set-paging loop (with a set larger than one SSCAN batch)
 *   - the zset WITHSCORES flat-array -> {member,score} pairing
 *   - per-type truncated math (truncated = total > returned) under a small `limit`
 *   - redis_key_info pipeline per-tuple tolerance + type==='none' -> exists:false
 *
 * Run via `npm run test:integration` with REDIS_URL pointing at a live server.
 * Skips cleanly when REDIS_URL is unset.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { shutdown } from "../api.js";
import {
  cleanupPrefix,
  closeSeedClient,
  getSeedClient,
  HAVE_REDIS,
  skipReason,
  supportsMemoryUsage,
  supportsStreams,
} from "./integration-harness.js";
import { keyspaceTools } from "./keyspace.js";

const PREFIX = "redis_mcp_it_ks:";
const k = (s: string) => `${PREFIX}${s}`;

const redis_get = keyspaceTools.find((t) => t.name === "redis_get")!;
const redis_key_info = keyspaceTools.find((t) => t.name === "redis_key_info")!;

// Type the handler return so the asserts read cleanly. Handlers return
// { ok, data?, error? } -- we only ever read `data` after asserting ok.
type R = { ok: boolean; data?: any; error?: string };

let streams = false;
let memUsage = false;

describe("integration: keyspace tools (live Redis)", { skip: skipReason() }, () => {
  before(async () => {
    if (!HAVE_REDIS) return;
    const seed = getSeedClient();
    await cleanupPrefix(seed, PREFIX);
    streams = await supportsStreams(seed);
    memUsage = await supportsMemoryUsage(seed);

    // One key of each type.
    await seed.set(k("str"), "hello world");

    // A string larger than the default value window (REDIS_MAX_VALUE_BYTES =
    // 262144) so redis_get must GETRANGE-window it and report truncated.
    await seed.set(k("bigstr"), "x".repeat(300_000));

    // Field-by-field HSET: variadic/object-form HSET is Redis 4+; doing it one
    // pair at a time keeps the seed working on older servers too (the handler
    // under test only ever READS via HGETALL, so seeding shape is incidental).
    await seed.hset(k("hash"), "f1", "v1");
    await seed.hset(k("hash"), "f2", "v2");
    await seed.hset(k("hash"), "f3", "v3");

    // list: 5 elements, pushed so index 0 is "L0".
    await seed.rpush(k("list"), "L0", "L1", "L2", "L3", "L4");

    // set: 250 members -- larger than the handler's SSCAN COUNT 200 so the
    // do/while loop must iterate more than once to collect them all.
    const setMembers = Array.from({ length: 250 }, (_, i) => `m${i}`);
    await seed.sadd(k("set"), ...setMembers);

    // zset: members with distinct scores so WITHSCORES pairing is checkable.
    await seed.zadd(k("zset"), 1, "z1", 2, "z2", 3, "z3", 4, "z4");

    if (streams) {
      await seed.xadd(k("stream"), "*", "field", "a");
      await seed.xadd(k("stream"), "*", "field", "b");
      await seed.xadd(k("stream"), "*", "field", "c");

      // A larger stream so a small `limit` returns fewer entries than XLEN --
      // exercises the corrected `truncated: total > entryCount` (the returned
      // payload size), not the old `total > cap`.
      for (let i = 0; i < 10; i++) {
        await seed.xadd(k("stream_big"), "*", "n", String(i));
      }
    }
  });

  after(async () => {
    if (!HAVE_REDIS) return;
    try {
      await cleanupPrefix(getSeedClient(), PREFIX);
    } finally {
      await closeSeedClient();
      // Tear down the handler's singleton so the process can exit.
      await shutdown();
    }
  });

  // ---- redis_get: type dispatch ----

  it("string -> { type:'string', value, length, truncated:false } under the window", async () => {
    const r = (await redis_get.handler({ key: k("str") })) as R;
    assert.equal(r.ok, true, r.error);
    assert.equal(r.data.type, "string");
    assert.equal(r.data.value, "hello world");
    assert.equal(r.data.length, 11, "length is the full STRLEN");
    assert.equal(r.data.truncated, false, "11 bytes !> the value window");
  });

  it("string -> windows a value larger than REDIS_MAX_VALUE_BYTES (truncated, full length reported)", async () => {
    const r = (await redis_get.handler({ key: k("bigstr") })) as R;
    assert.equal(r.ok, true, r.error);
    assert.equal(r.data.type, "string");
    assert.equal(r.data.length, 300_000, "length is the full STRLEN");
    assert.equal(r.data.value.length, 262_144, "value windowed to REDIS_MAX_VALUE_BYTES (default 256 KiB)");
    assert.equal(r.data.truncated, true, "300000 > 262144");
  });

  it("hash -> { type:'hash', fields object, field_count is HLEN total, truncated:false under limit }", async () => {
    const r = (await redis_get.handler({ key: k("hash") })) as R;
    assert.equal(r.ok, true, r.error);
    assert.equal(r.data.type, "hash");
    assert.deepEqual(r.data.fields, { f1: "v1", f2: "v2", f3: "v3" });
    assert.equal(r.data.field_count, 3, "field_count is the full HLEN");
    assert.equal(r.data.truncated, false, "3 total !> 3 returned");
  });

  it("hash -> HSCAN-bounded read: truncated + fields capped at `limit` (HLEN total stays full)", async () => {
    const r = (await redis_get.handler({ key: k("hash"), limit: 1 })) as R;
    assert.equal(r.ok, true, r.error);
    assert.equal(r.data.type, "hash");
    assert.equal(r.data.field_count, 3, "field_count is the full HLEN, not the window");
    assert.equal(Object.keys(r.data.fields).length, 1, "HSCAN loop stops once count >= cap");
    assert.equal(r.data.truncated, true, "3 total > 1 returned");
  });

  it("list -> ordered values, length, truncated:false when under limit", async () => {
    const r = (await redis_get.handler({ key: k("list") })) as R;
    assert.equal(r.ok, true, r.error);
    assert.equal(r.data.type, "list");
    assert.equal(r.data.length, 5);
    assert.deepEqual(r.data.values, ["L0", "L1", "L2", "L3", "L4"]);
    assert.equal(r.data.truncated, false);
  });

  it("list -> truncated:true and exactly `limit` values when over the cap (LRANGE 0..limit-1)", async () => {
    const r = (await redis_get.handler({ key: k("list"), limit: 2 })) as R;
    assert.equal(r.ok, true, r.error);
    assert.equal(r.data.length, 5, "length is the full LLEN, not the window");
    assert.deepEqual(r.data.values, ["L0", "L1"], "LRANGE 0..(limit-1) inclusive");
    assert.equal(r.data.truncated, true, "5 total > 2 returned");
  });

  it("set -> SSCAN paging collects all members across >1 batch (cardinality 250)", async () => {
    const r = (await redis_get.handler({ key: k("set") })) as R;
    assert.equal(r.ok, true, r.error);
    assert.equal(r.data.type, "set");
    assert.equal(r.data.cardinality, 250);
    assert.equal(r.data.members.length, 250, "SSCAN loop must page past the COUNT 200 batch");
    // membership, not order (SSCAN order is unspecified)
    const got = new Set<string>(r.data.members);
    assert.equal(got.size, 250);
    assert.ok(got.has("m0") && got.has("m249"));
    assert.equal(r.data.truncated, false);
  });

  it("set -> truncated + members capped at `limit` (SSCAN loop honors the cap)", async () => {
    const r = (await redis_get.handler({ key: k("set"), limit: 10 })) as R;
    assert.equal(r.ok, true, r.error);
    assert.equal(r.data.cardinality, 250);
    assert.equal(r.data.members.length, 10, "loop stops once members.length >= cap");
    assert.equal(r.data.truncated, true, "250 total > 10 returned");
  });

  it("zset -> WITHSCORES flat reply paired into {member,score}, score is a string", async () => {
    const r = (await redis_get.handler({ key: k("zset") })) as R;
    assert.equal(r.ok, true, r.error);
    assert.equal(r.data.type, "zset");
    assert.equal(r.data.cardinality, 4);
    assert.deepEqual(r.data.members, [
      { member: "z1", score: "1" },
      { member: "z2", score: "2" },
      { member: "z3", score: "3" },
      { member: "z4", score: "4" },
    ]);
    assert.equal(r.data.truncated, false);
  });

  it("zset -> truncated + pairing intact under a small limit (ZRANGE 0..limit-1 WITHSCORES)", async () => {
    const r = (await redis_get.handler({ key: k("zset"), limit: 2 })) as R;
    assert.equal(r.ok, true, r.error);
    assert.equal(r.data.cardinality, 4);
    assert.deepEqual(r.data.members, [
      { member: "z1", score: "1" },
      { member: "z2", score: "2" },
    ]);
    assert.equal(r.data.truncated, true, "4 total > 2 pairs");
  });

  it("stream -> XREVRANGE newest-first entries, length, truncated math", async (t) => {
    if (!streams) {
      t.skip("server has no Streams (XADD) -- pre-5.0 build");
      return;
    }
    const r = (await redis_get.handler({ key: k("stream") })) as R;
    assert.equal(r.ok, true, r.error);
    assert.equal(r.data.type, "stream");
    assert.equal(r.data.length, 3);
    assert.ok(Array.isArray(r.data.entries));
    assert.equal(r.data.entries.length, 3);
    assert.equal(r.data.truncated, false, "3 total !> cap (default)");

    // newest-first: XREVRANGE returns the last-added entry first.
    const rLimited = (await redis_get.handler({ key: k("stream"), limit: 1 })) as R;
    assert.equal(rLimited.data.entries.length, 1);
    assert.equal(rLimited.data.truncated, true, "3 total > cap 1");
  });

  it("stream -> truncated measures the returned payload (total > entryCount), not the cap", async (t) => {
    if (!streams) {
      t.skip("server has no Streams (XADD) -- pre-5.0 build");
      return;
    }
    // 10 seeded entries, limit 4 -> XREVRANGE COUNT 4 returns 4 entries.
    const r = (await redis_get.handler({ key: k("stream_big"), limit: 4 })) as R;
    assert.equal(r.ok, true, r.error);
    assert.equal(r.data.type, "stream");
    assert.equal(r.data.length, 10, "length is the full XLEN");
    assert.ok(Array.isArray(r.data.entries));
    assert.equal(r.data.entries.length, 4, "XREVRANGE COUNT honors the limit");
    assert.equal(r.data.truncated, true, "10 total > 4 returned entries");

    // Under no limit (cap defaults to REDIS_MAX_KEYS >= 10) all 10 come back -> not truncated.
    const rAll = (await redis_get.handler({ key: k("stream_big") })) as R;
    assert.equal(rAll.data.entries.length, 10);
    assert.equal(rAll.data.truncated, false, "10 total !> 10 returned entries");
  });

  it("missing key -> { exists:false }", async () => {
    const r = (await redis_get.handler({ key: k("does_not_exist") })) as R;
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.data, { key: k("does_not_exist"), exists: false });
  });

  // ---- redis_key_info ----

  it("key_info on a real key -> exists:true, type, ttl_seconds, has_expiry false (no TTL set)", async () => {
    const r = (await redis_key_info.handler({ key: k("str") })) as R;
    assert.equal(r.ok, true, r.error);
    assert.equal(r.data.exists, true);
    assert.equal(r.data.type, "string");
    assert.equal(r.data.ttl_seconds, -1, "no expiry -> TTL -1");
    assert.equal(r.data.has_expiry, false);
    // encoding comes from OBJECT ENCODING (supported on every Redis that runs here)
    assert.ok(typeof r.data.encoding === "string" && r.data.encoding.length > 0);
  });

  it("key_info reports has_expiry:true when a TTL is set", async () => {
    const seed = getSeedClient();
    await seed.set(k("withttl"), "x", "EX", 1000);
    const r = (await redis_key_info.handler({ key: k("withttl") })) as R;
    assert.equal(r.ok, true, r.error);
    assert.equal(r.data.exists, true);
    assert.ok(r.data.ttl_seconds > 0 && r.data.ttl_seconds <= 1000);
    assert.equal(r.data.has_expiry, true);
  });

  it("key_info per-probe tolerance: MEMORY USAGE may be unsupported but the call still returns exists:true", async () => {
    const r = (await redis_key_info.handler({ key: k("hash") })) as R;
    assert.equal(r.ok, true, r.error);
    assert.equal(r.data.exists, true);
    assert.equal(r.data.type, "hash");
    if (memUsage) {
      assert.ok(
        typeof r.data.memory_usage_bytes === "number" && r.data.memory_usage_bytes > 0,
        "MEMORY USAGE supported -> a positive byte count",
      );
    } else {
      assert.equal(
        r.data.memory_usage_bytes,
        null,
        "MEMORY USAGE unsupported -> the per-tuple error is swallowed to null, not a thrown handler error",
      );
    }
  });

  it("key_info on a missing key -> { exists:false } (type==='none' short-circuit)", async () => {
    const r = (await redis_key_info.handler({ key: k("nope") })) as R;
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.data, { key: k("nope"), exists: false });
  });
});
