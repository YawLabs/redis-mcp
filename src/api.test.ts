import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  formatRedisError,
  getClient,
  getCommandTimeoutMs,
  getConnectTimeoutMs,
  getMaxKeys,
  getMaxValueBytes,
  getScanCount,
  getTlsConfig,
  isWritesAllowed,
  OAM_TLS_MIN,
  runCommand,
  shutdown,
  tlsRuntimeProblem,
  wouldUseTls,
} from "./api.js";

describe("isWritesAllowed", () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.ALLOW_WRITES;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.ALLOW_WRITES;
    else process.env.ALLOW_WRITES = original;
  });

  it("defaults to false when unset", () => {
    delete process.env.ALLOW_WRITES;
    assert.equal(isWritesAllowed(), false);
  });

  it("is true for '1' and 'true'", () => {
    process.env.ALLOW_WRITES = "1";
    assert.equal(isWritesAllowed(), true);
    process.env.ALLOW_WRITES = "true";
    assert.equal(isWritesAllowed(), true);
  });

  it("is false for other truthy-looking strings (strict opt-in)", () => {
    for (const v of ["yes", "y", "on", "TRUE", "True", "0", "false", ""]) {
      process.env.ALLOW_WRITES = v;
      assert.equal(isWritesAllowed(), false, `ALLOW_WRITES=${JSON.stringify(v)} should be false`);
    }
  });
});

describe("getMaxKeys", () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.REDIS_MAX_KEYS;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.REDIS_MAX_KEYS;
    else process.env.REDIS_MAX_KEYS = original;
  });

  it("defaults to 1000", () => {
    delete process.env.REDIS_MAX_KEYS;
    assert.equal(getMaxKeys(), 1000);
  });

  it("accepts positive integers and floors fractional", () => {
    process.env.REDIS_MAX_KEYS = "50";
    assert.equal(getMaxKeys(), 50);
    process.env.REDIS_MAX_KEYS = "99.9";
    assert.equal(getMaxKeys(), 99);
  });

  it("falls back to 1000 for invalid values, including a value below 1", () => {
    // "0.5", "0.999" and "1e-3" pass a `> 0` check and floor to 0, and a cap
    // of 0 returns a whole list or zset from redis_get (`LRANGE key 0 -1`)
    // with `truncated: false`, and no keys from any scan (#13).
    for (const v of ["abc", "-5", "0", "", "0.5", "0.999", "1e-3"]) {
      process.env.REDIS_MAX_KEYS = v;
      assert.equal(getMaxKeys(), 1000, `REDIS_MAX_KEYS=${JSON.stringify(v)} should default`);
    }
  });

  it("accepts exactly 1, the smallest cap that still caps", () => {
    process.env.REDIS_MAX_KEYS = "1";
    assert.equal(getMaxKeys(), 1);
    process.env.REDIS_MAX_KEYS = "1.5";
    assert.equal(getMaxKeys(), 1);
  });

  it("clamps absurdly large values to 1_000_000", () => {
    process.env.REDIS_MAX_KEYS = "100000000";
    assert.equal(getMaxKeys(), 1_000_000);
  });
});

describe("getScanCount", () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.REDIS_SCAN_COUNT;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.REDIS_SCAN_COUNT;
    else process.env.REDIS_SCAN_COUNT = original;
  });

  it("defaults to 100", () => {
    delete process.env.REDIS_SCAN_COUNT;
    assert.equal(getScanCount(), 100);
  });

  it("accepts positive integers, floors fractional, defaults on invalid", () => {
    process.env.REDIS_SCAN_COUNT = "250";
    assert.equal(getScanCount(), 250);
    process.env.REDIS_SCAN_COUNT = "10.7";
    assert.equal(getScanCount(), 10);
    process.env.REDIS_SCAN_COUNT = "0";
    assert.equal(getScanCount(), 100);
  });

  it("falls back to 100 for a value below 1, which would floor to a COUNT Redis rejects", () => {
    // Redis answers `SCAN ... COUNT 0` with a syntax error, so every call that
    // used the env value (redis_advisor, redis_scan without `count`) failed (#13).
    for (const v of ["0.5", "0.999", "1e-3"]) {
      process.env.REDIS_SCAN_COUNT = v;
      assert.equal(getScanCount(), 100, `REDIS_SCAN_COUNT=${JSON.stringify(v)} should default`);
    }
    process.env.REDIS_SCAN_COUNT = "1";
    assert.equal(getScanCount(), 1, "exactly 1 is the smallest COUNT Redis accepts");
  });

  it("clamps absurdly large values to 1_000_000", () => {
    process.env.REDIS_SCAN_COUNT = "50000000";
    assert.equal(getScanCount(), 1_000_000);
  });
});

describe("getMaxValueBytes", () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.REDIS_MAX_VALUE_BYTES;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.REDIS_MAX_VALUE_BYTES;
    else process.env.REDIS_MAX_VALUE_BYTES = original;
  });

  it("defaults to 256 KiB (262144)", () => {
    delete process.env.REDIS_MAX_VALUE_BYTES;
    assert.equal(getMaxValueBytes(), 262_144);
  });

  it("accepts positive integers, floors fractional, defaults on invalid", () => {
    process.env.REDIS_MAX_VALUE_BYTES = "1024";
    assert.equal(getMaxValueBytes(), 1024);
    process.env.REDIS_MAX_VALUE_BYTES = "1024.9";
    assert.equal(getMaxValueBytes(), 1024);
    // A value below 1 used to floor to 0, which sends `GETRANGE key 0 -1` --
    // the whole string -- while reporting `truncated: true` (#13).
    for (const v of ["abc", "-5", "0", "", "0.5", "0.999", "1e-3"]) {
      process.env.REDIS_MAX_VALUE_BYTES = v;
      assert.equal(getMaxValueBytes(), 262_144, `REDIS_MAX_VALUE_BYTES=${JSON.stringify(v)} should default`);
    }
    process.env.REDIS_MAX_VALUE_BYTES = "1";
    assert.equal(getMaxValueBytes(), 1, "exactly 1 is the smallest cap that still caps");
  });

  it("clamps absurdly large values to the 64 MB ceiling", () => {
    process.env.REDIS_MAX_VALUE_BYTES = "999999999999";
    assert.equal(getMaxValueBytes(), 64_000_000);
  });
});

describe("getCommandTimeoutMs / getConnectTimeoutMs", () => {
  let origCmd: string | undefined;
  let origConn: string | undefined;
  beforeEach(() => {
    origCmd = process.env.REDIS_COMMAND_TIMEOUT_MS;
    origConn = process.env.REDIS_CONNECT_TIMEOUT_MS;
  });
  afterEach(() => {
    if (origCmd === undefined) delete process.env.REDIS_COMMAND_TIMEOUT_MS;
    else process.env.REDIS_COMMAND_TIMEOUT_MS = origCmd;
    if (origConn === undefined) delete process.env.REDIS_CONNECT_TIMEOUT_MS;
    else process.env.REDIS_CONNECT_TIMEOUT_MS = origConn;
  });

  it("both default to 10000", () => {
    delete process.env.REDIS_COMMAND_TIMEOUT_MS;
    delete process.env.REDIS_CONNECT_TIMEOUT_MS;
    assert.equal(getCommandTimeoutMs(), 10_000);
    assert.equal(getConnectTimeoutMs(), 10_000);
  });

  it("accept positive numbers and floor to integer ms (sub-ms is below network noise)", () => {
    process.env.REDIS_COMMAND_TIMEOUT_MS = "2500.5";
    assert.equal(getCommandTimeoutMs(), 2500, "fractional floors to integer ms");
    process.env.REDIS_CONNECT_TIMEOUT_MS = "3000";
    assert.equal(getConnectTimeoutMs(), 3000);
    // Sub-ms values floor to 1 rather than 0/negative, which would disable the timeout.
    process.env.REDIS_COMMAND_TIMEOUT_MS = "0.5";
    assert.equal(getCommandTimeoutMs(), 1, "sub-ms floors to 1, not 0");
  });

  it("fall back to 10000 on invalid", () => {
    for (const v of ["abc", "-5", "0", ""]) {
      process.env.REDIS_COMMAND_TIMEOUT_MS = v;
      assert.equal(getCommandTimeoutMs(), 10_000);
    }
  });
});

describe("getTlsConfig", () => {
  let original: string | undefined;
  const originalErr = console.error;
  let stderrCalls: string[] = [];

  beforeEach(() => {
    original = process.env.REDIS_TLS_REJECT_UNAUTHORIZED;
    stderrCalls = [];
    console.error = (msg?: unknown) => {
      stderrCalls.push(String(msg));
    };
  });
  afterEach(() => {
    console.error = originalErr;
    if (original === undefined) delete process.env.REDIS_TLS_REJECT_UNAUTHORIZED;
    else process.env.REDIS_TLS_REJECT_UNAUTHORIZED = original;
  });

  it("returns undefined when unset (no warning)", () => {
    delete process.env.REDIS_TLS_REJECT_UNAUTHORIZED;
    assert.equal(getTlsConfig(), undefined);
    assert.equal(stderrCalls.length, 0);
  });

  it("maps '0'/'false' -> rejectUnauthorized:false, '1'/'true' -> true, no warning", () => {
    for (const v of ["0", "false"]) {
      process.env.REDIS_TLS_REJECT_UNAUTHORIZED = v;
      assert.deepEqual(getTlsConfig(), { rejectUnauthorized: false });
    }
    for (const v of ["1", "true"]) {
      process.env.REDIS_TLS_REJECT_UNAUTHORIZED = v;
      assert.deepEqual(getTlsConfig(), { rejectUnauthorized: true });
    }
    assert.equal(stderrCalls.length, 0, "recognized values must not warn");
  });

  it("returns undefined AND warns on an unrecognized value (typo)", () => {
    process.env.REDIS_TLS_REJECT_UNAUTHORIZED = "Flase";
    assert.equal(getTlsConfig(), undefined);
    assert.equal(stderrCalls.length, 1);
    assert.match(stderrCalls[0]!, /REDIS_TLS_REJECT_UNAUTHORIZED/);
    assert.match(stderrCalls[0]!, /not recognized/i);
    assert.match(stderrCalls[0]!, /Flase/);
  });
});

describe("formatRedisError", () => {
  it("passes through a plain Error message (carries the Redis error-code prefix)", () => {
    // Generic `Error` instances have `name === "Error"`; we don't prefix
    // those (would be noisy) -- the message already has the Redis prefix.
    assert.equal(
      formatRedisError(new Error("READONLY You can't write against a read only replica.")),
      "READONLY You can't write against a read only replica.",
    );
  });

  it("prefixes a non-generic err.name so agents can distinguish error classes", () => {
    // ioredis errors: ReplyError (server reply, e.g. WRONGTYPE), ConnectionError
    // (socket dropped), MaxRetriesPerRequestError (retry budget exhausted).
    // The class name in the prefix lets an agent triage without parsing the
    // message.
    const replyErr = new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
    replyErr.name = "ReplyError";
    assert.equal(
      formatRedisError(replyErr),
      "ReplyError: WRONGTYPE Operation against a key holding the wrong kind of value",
    );

    const connErr = new Error("Connection is closed.");
    connErr.name = "ConnectionError";
    assert.equal(formatRedisError(connErr), "ConnectionError: Connection is closed.");
  });

  it("stringifies non-Error values", () => {
    assert.equal(formatRedisError("boom"), "boom");
    assert.equal(formatRedisError(42), "42");
  });
});

describe("TLS on an oam too old to carry it", () => {
  const KEYS = ["REDIS_URL", "REDIS_TLS_REJECT_UNAUTHORIZED"];
  let saved: Record<string, string | undefined> = {};
  beforeEach(async () => {
    saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
    await shutdown();
  });
  afterEach(async () => {
    await shutdown();
    delete (process.versions as Record<string, string>).oam;
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  /** Make this Node process report `process.versions.oam`, as an oam host does. */
  const poseAsOam = (version: string) =>
    Object.defineProperty(process.versions, "oam", { value: version, configurable: true, enumerable: true });

  it("keeps its floor equal to the launcher's", () => {
    // The launcher refuses an oam below OAM_MIN; the server refuses TLS below
    // OAM_TLS_MIN for hosts that skip the launcher. One number, two places.
    const launcher = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "redis-mcp.mjs"),
      "utf-8",
    );
    const floor = /const OAM_MIN = \[([^\]]*)\];/
      .exec(launcher)?.[1]
      ?.split(",")
      .map((n) => Number(n.trim()));
    assert.deepEqual(floor, [...OAM_TLS_MIN]);
  });

  it("names the problem below the floor, and nothing at or above it, on Node, or on an unreadable version", () => {
    for (const version of ["0.15.2", "0.15.0", "0.9.0", "0.0.1"]) {
      const problem = tlsRuntimeProblem(version);
      assert.match(
        problem ?? "",
        new RegExp(`needs oam ${OAM_TLS_MIN.join("\\.")} or newer.*running on oam ${version.replace(/\./g, "\\.")}`),
      );
      assert.match(problem ?? "", /oamjs\.org/);
    }
    // 0.100.0 sorts before 0.15.3 as a string; the compare must be numeric.
    for (const version of ["0.15.3", "0.15.10", "0.16.0", "0.100.0", "1.0.0", "0.15.3-dev"]) {
      assert.equal(tlsRuntimeProblem(version), null, version);
    }
    assert.equal(tlsRuntimeProblem(undefined), null, "Node");
    assert.equal(tlsRuntimeProblem("dev"), null, "an unreadable version is not refused");
  });

  it("makes a rediss:// tool call on an old oam return that error instead of crashing, and builds no client", async () => {
    poseAsOam("0.15.2");
    process.env.REDIS_URL = "rediss://127.0.0.1:1";
    const reply = await runCommand("PING", []);
    assert.equal(reply.ok, false);
    assert.match(reply.error ?? "", /needs oam 0\.15\.3 or newer, and this server is running on oam 0\.15\.2/);
    // Refused before anything was cached, so an updated runtime is picked up.
    assert.throws(() => getClient(), /needs oam 0\.15\.3/);
  });

  it("refuses TLS turned on by REDIS_TLS_REJECT_UNAUTHORIZED too, and leaves plain redis:// alone", async () => {
    poseAsOam("0.15.2");
    process.env.REDIS_URL = "redis://127.0.0.1:1";
    process.env.REDIS_TLS_REJECT_UNAUTHORIZED = "false";
    assert.throws(() => getClient(), /needs oam 0\.15\.3/);
    await shutdown();
    delete process.env.REDIS_TLS_REJECT_UNAUTHORIZED;
    assert.doesNotThrow(() => getClient());
  });

  it("lets TLS through on an oam at the floor", () => {
    poseAsOam("0.15.3");
    process.env.REDIS_URL = "rediss://127.0.0.1:1";
    assert.doesNotThrow(() => getClient());
  });

  it("predicts TLS exactly as the built client decides it", async () => {
    // wouldUseTls feeds the startup warning; getClient decides from the client.
    // They must agree, or the warning lies.
    const cases: [string, string | undefined][] = [
      ["rediss://127.0.0.1:1", undefined],
      ["redis://127.0.0.1:1", undefined],
      ["REDISS://127.0.0.1:1", undefined],
      ["redis://127.0.0.1:1", "false"],
      ["redis://127.0.0.1:1", "true"],
      ["redis://127.0.0.1:1", "yes"],
      ["rediss://127.0.0.1:1", "0"],
      ["127.0.0.1:1", undefined],
    ];
    const original = console.error;
    console.error = () => {};
    try {
      for (const [url, reject] of cases) {
        await shutdown();
        process.env.REDIS_URL = url;
        if (reject === undefined) delete process.env.REDIS_TLS_REJECT_UNAUTHORIZED;
        else process.env.REDIS_TLS_REJECT_UNAUTHORIZED = reject;
        assert.equal(wouldUseTls(), Boolean(getClient().options.tls), `${url} REDIS_TLS_REJECT_UNAUTHORIZED=${reject}`);
      }
    } finally {
      console.error = original;
    }
  });
});
