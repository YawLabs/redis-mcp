import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseInfo, parseKeyspace, parseSlowlog } from "./info.js";

const SAMPLE_INFO = [
  "# Server",
  "redis_version:7.2.4",
  "redis_mode:standalone",
  "uptime_in_seconds:12345",
  "",
  "# Clients",
  "connected_clients:12",
  "blocked_clients:0",
  "",
  "# Memory",
  "used_memory:1048576",
  "used_memory_human:1.00M",
  "maxmemory:2097152",
  "maxmemory_policy:noeviction",
  "",
  "# Keyspace",
  "db0:keys=120,expires=8,avg_ttl=0",
  "db1:keys=5,expires=5,avg_ttl=100",
].join("\r\n");

describe("parseInfo", () => {
  it("flattens field:value lines across sections, skipping # headers and blanks", () => {
    const info = parseInfo(SAMPLE_INFO);
    assert.equal(info.redis_version, "7.2.4");
    assert.equal(info.connected_clients, "12");
    assert.equal(info.maxmemory_policy, "noeviction");
    // Section headers are not keys.
    assert.equal(info["# Server"], undefined);
    assert.equal(info.Server, undefined);
  });

  it("handles LF-only line endings as well as CRLF", () => {
    const info = parseInfo("redis_version:7.0.0\nconnected_clients:3");
    assert.equal(info.redis_version, "7.0.0");
    assert.equal(info.connected_clients, "3");
  });

  it("keeps values that themselves contain a colon", () => {
    // e.g. some fields embed host:port.
    const info = parseInfo("master_host:10.0.0.1:6379");
    assert.equal(info.master_host, "10.0.0.1:6379");
  });

  it("returns an empty object for empty input", () => {
    assert.deepEqual(parseInfo(""), {});
  });
});

describe("parseKeyspace", () => {
  it("parses per-db key counts and derives keys_without_ttl", () => {
    const dbs = parseKeyspace(parseInfo(SAMPLE_INFO));
    assert.equal(dbs.length, 2);
    const db0 = dbs[0]!;
    assert.equal(db0.db, 0);
    assert.equal(db0.keys, 120);
    assert.equal(db0.expires, 8);
    assert.equal(db0.keys_without_ttl, 112); // 120 - 8
    const db1 = dbs[1]!;
    assert.equal(db1.keys_without_ttl, 0); // all 5 have a TTL
  });

  it("sorts by db number", () => {
    const info = parseInfo("db2:keys=1,expires=0,avg_ttl=0\ndb0:keys=1,expires=0,avg_ttl=0");
    const dbs = parseKeyspace(info);
    assert.deepEqual(
      dbs.map((d) => d.db),
      [0, 2],
    );
  });

  it("returns empty when there are no db lines", () => {
    assert.deepEqual(parseKeyspace(parseInfo("redis_version:7.0.0")), []);
  });

  it("never reports a negative keys_without_ttl even if expires > keys (defensive)", () => {
    const info = parseInfo("db0:keys=2,expires=9,avg_ttl=0");
    assert.equal(parseKeyspace(info)[0]!.keys_without_ttl, 0);
  });
});

describe("parseSlowlog", () => {
  it("normalizes the nested-array reply shape (with client fields, Redis 4+)", () => {
    const raw = [
      [42, 1700000000, 15000, ["GET", "bigkey"], "127.0.0.1:54321", "app-worker"],
      [41, 1699999999, 9000, ["HGETALL", "h"], "127.0.0.1:54322", ""],
    ];
    const entries = parseSlowlog(raw);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]!.id, 42);
    assert.equal(entries[0]!.micros, 15000);
    assert.equal(entries[0]!.command, "GET bigkey");
    assert.equal(entries[0]!.client_addr, "127.0.0.1:54321");
    assert.equal(entries[0]!.client_name, "app-worker");
  });

  it("handles the older 4-field shape without client info", () => {
    const raw = [[1, 1700000000, 12000, ["PING"]]];
    const entries = parseSlowlog(raw);
    assert.equal(entries[0]!.command, "PING");
    assert.equal(entries[0]!.client_addr, null);
    assert.equal(entries[0]!.client_name, null);
  });

  it("returns [] for a non-array reply", () => {
    assert.deepEqual(parseSlowlog(null), []);
    assert.deepEqual(parseSlowlog("oops"), []);
    assert.deepEqual(parseSlowlog(undefined), []);
  });

  it("skips malformed entries rather than throwing", () => {
    const raw = [
      ["too", "short"],
      [7, 1700000000, 11000, ["DEL", "x"]],
    ];
    const entries = parseSlowlog(raw);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.id, 7);
  });
});
