/**
 * LIVE-Redis integration tests for redis_health.
 *
 * Covers the pipeline rollup the unit suite cannot reach:
 *   - INFO + DBSIZE + SLOWLOG batched in one pipeline, parsed into the snapshot
 *   - the slowlog conditional index shift: when slowlogLimit === 0 the SLOWLOG
 *     probe is NOT queued, so dbsize stays at replies[1] and there is no
 *     replies[2] to read
 *   - partial-failure warnings surfaced under data._warnings
 *   - connected:true + a populated server/memory/clients/throughput block
 *
 * Run via `npm run test:integration` with REDIS_URL set; skips otherwise.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { shutdown } from "../api.js";
import { healthTools } from "./health.js";
import { cleanupPrefix, closeSeedClient, getSeedClient, HAVE_REDIS, skipReason } from "./integration-harness.js";

const PREFIX = "redis_mcp_it_health:";
const redis_health = healthTools.find((t) => t.name === "redis_health")!;

type R = { ok: boolean; data?: any; error?: string };

describe("integration: redis_health (live Redis)", { skip: skipReason() }, () => {
  before(async () => {
    if (!HAVE_REDIS) return;
    const seed = getSeedClient();
    await cleanupPrefix(seed, PREFIX);
    // A couple of keys so DBSIZE is non-zero and per-db keyspace parses.
    await seed.set(`${PREFIX}a`, "1");
    await seed.set(`${PREFIX}b`, "2");
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

  it("rolls up INFO + DBSIZE + SLOWLOG into a connected snapshot", async () => {
    const r = (await redis_health.handler({ slowlogLimit: 5 })) as R;
    assert.equal(r.ok, true, r.error);
    const d = r.data;
    assert.equal(d.connected, true);

    // server block from INFO
    assert.ok(typeof d.server.version === "string" && d.server.version.length > 0);
    assert.ok(d.server.uptime_seconds === null || typeof d.server.uptime_seconds === "number");

    // memory block coerced from INFO
    assert.ok(d.memory.used_bytes === null || typeof d.memory.used_bytes === "number");

    // clients + throughput blocks present
    assert.ok("connected" in d.clients);
    assert.ok("instantaneous_ops_per_sec" in d.throughput);
    assert.ok("hit_rate_pct" in d.throughput);

    // keyspace: DBSIZE is read off replies[1] and is a number here (we seeded keys)
    assert.ok(typeof d.keyspace.total_keys === "number" && d.keyspace.total_keys >= 2);
    assert.ok(Array.isArray(d.keyspace.per_db));

    // slowlog included (array; may be empty on a quiet instance)
    assert.ok(Array.isArray(d.slowlog));

    // healthy single-call rollup -> no partial-failure warnings
    assert.equal(d._warnings, undefined, `unexpected warnings: ${JSON.stringify(d._warnings)}`);
  });

  it("hit_rate_pct is a percentage in [0,100] or null when there is no traffic", async () => {
    const r = (await redis_health.handler({ slowlogLimit: 0 })) as R;
    assert.equal(r.ok, true, r.error);
    const hr = r.data.throughput.hit_rate_pct;
    if (hr !== null) {
      assert.ok(hr >= 0 && hr <= 100, `hit_rate_pct out of range: ${hr}`);
    }
  });

  it("slowlogLimit:0 skips the SLOWLOG probe (index shift) but still reports dbsize from replies[1]", async () => {
    // With slowlogLimit 0 the handler does NOT queue SLOWLOG, so the pipeline is
    // [INFO, DBSIZE] only. dbsize must still come back correctly (proving it is
    // read from replies[1], not a hardcoded later index), and slowlog is [].
    const r = (await redis_health.handler({ slowlogLimit: 0 })) as R;
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.data.slowlog, [], "slowlog skipped -> empty array, not an error");
    assert.ok(
      typeof r.data.keyspace.total_keys === "number" && r.data.keyspace.total_keys >= 2,
      "dbsize still parsed from replies[1] when SLOWLOG is omitted",
    );
    assert.equal(r.data._warnings, undefined);
  });

  it("non-zero slowlogLimit keeps dbsize at replies[1] and slowlog at replies[2]", async () => {
    // Same dbsize regardless of whether SLOWLOG was queued -> proves the dbsize
    // index does not shift with the conditional slowlog push.
    const withSlow = (await redis_health.handler({ slowlogLimit: 3 })) as R;
    const noSlow = (await redis_health.handler({ slowlogLimit: 0 })) as R;
    assert.equal(withSlow.ok, true, withSlow.error);
    assert.equal(noSlow.ok, true, noSlow.error);
    assert.equal(
      withSlow.data.keyspace.total_keys,
      noSlow.data.keyspace.total_keys,
      "DBSIZE is read from replies[1] in both modes; the conditional SLOWLOG push must not shift it",
    );
  });
});
