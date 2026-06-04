import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  formatRedisError,
  getCommandTimeoutMs,
  getConnectTimeoutMs,
  getMaxKeys,
  getScanCount,
  getTlsConfig,
  isWritesAllowed,
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

  it("falls back to 1000 for invalid values", () => {
    for (const v of ["abc", "-5", "0", ""]) {
      process.env.REDIS_MAX_KEYS = v;
      assert.equal(getMaxKeys(), 1000, `REDIS_MAX_KEYS=${JSON.stringify(v)} should default`);
    }
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
