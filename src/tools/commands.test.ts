import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyCommand, READONLY_COMMANDS, WRITE_COMMANDS } from "./commands.js";

describe("classifyCommand: read-only commands", () => {
  it("allows core reads regardless of ALLOW_WRITES", () => {
    for (const writes of [false, true]) {
      for (const cmd of ["GET", "hgetall", "LRANGE", "TYPE", "ttl", "EXISTS", "scan", "smembers", "zrange"]) {
        const r = classifyCommand(cmd, writes);
        assert.equal(r.allowed, true, `${cmd} (writes=${writes}) should be allowed`);
        assert.equal(r.kind, "read");
      }
    }
  });

  it("is case-insensitive on the verb", () => {
    assert.equal(classifyCommand("GeT", false).allowed, true);
    assert.equal(classifyCommand("HGETALL", false).allowed, true);
  });

  it("trims whitespace around the verb", () => {
    assert.equal(classifyCommand("  get  ", false).allowed, true);
  });
});

describe("classifyCommand: KEYS is blocked with a SCAN nudge", () => {
  it("blocks KEYS even though it is technically a read", () => {
    const r = classifyCommand("KEYS", true); // even with writes on
    assert.equal(r.allowed, false);
    assert.equal(r.kind, "read");
    assert.match(r.reason, /SCAN/);
    assert.match(r.reason, /O\(N\)/);
  });
});

describe("classifyCommand: write commands gated by ALLOW_WRITES", () => {
  it("blocks writes when ALLOW_WRITES is off", () => {
    for (const cmd of ["SET", "del", "EXPIRE", "hset", "lpush", "ZADD", "flushdb"]) {
      const r = classifyCommand(cmd, false);
      assert.equal(r.allowed, false, `${cmd} should be blocked with writes off`);
      assert.equal(r.kind, "write");
      assert.match(r.reason, /ALLOW_WRITES/);
    }
  });

  it("allows writes when ALLOW_WRITES is on", () => {
    for (const cmd of ["SET", "del", "EXPIRE", "hset", "lpush", "ZADD"]) {
      const r = classifyCommand(cmd, true);
      assert.equal(r.allowed, true, `${cmd} should be allowed with writes on`);
      assert.equal(r.kind, "write");
    }
  });
});

describe("classifyCommand: subcommand-sensitive multi-word commands", () => {
  it("CONFIG GET is read-only, CONFIG SET is a gated write", () => {
    assert.equal(classifyCommand("CONFIG", false, "GET").allowed, true);
    assert.equal(classifyCommand("CONFIG", false, "get").kind, "read");

    const setOff = classifyCommand("CONFIG", false, "SET");
    assert.equal(setOff.allowed, false);
    assert.equal(setOff.kind, "write");
    assert.match(setOff.reason, /ALLOW_WRITES/);

    const setOn = classifyCommand("CONFIG", true, "SET");
    assert.equal(setOn.allowed, true);
    assert.equal(setOn.kind, "write");
  });

  it("SLOWLOG GET/LEN read-only, SLOWLOG RESET gated", () => {
    assert.equal(classifyCommand("SLOWLOG", false, "GET").allowed, true);
    assert.equal(classifyCommand("SLOWLOG", false, "LEN").allowed, true);
    assert.equal(classifyCommand("SLOWLOG", false, "RESET").allowed, false);
    assert.equal(classifyCommand("SLOWLOG", true, "RESET").allowed, true);
  });

  it("CLIENT LIST read-only, CLIENT KILL gated", () => {
    assert.equal(classifyCommand("CLIENT", false, "LIST").allowed, true);
    assert.equal(classifyCommand("CLIENT", false, "KILL").allowed, false);
    assert.equal(classifyCommand("CLIENT", true, "KILL").allowed, true);
  });

  it("MEMORY USAGE/STATS read-only, MEMORY PURGE gated", () => {
    assert.equal(classifyCommand("MEMORY", false, "USAGE").allowed, true);
    assert.equal(classifyCommand("MEMORY", false, "STATS").allowed, true);
    assert.equal(classifyCommand("MEMORY", false, "PURGE").allowed, false);
  });

  it("ACL read subcommands allowed, ACL SETUSER gated", () => {
    assert.equal(classifyCommand("ACL", false, "WHOAMI").allowed, true);
    assert.equal(classifyCommand("ACL", false, "GETUSER").allowed, true);
    assert.equal(classifyCommand("ACL", false, "SETUSER").allowed, false);
  });

  it("a multi-word command with no subcommand is rejected for ambiguity", () => {
    const r = classifyCommand("CONFIG", false);
    assert.equal(r.allowed, false);
    assert.match(r.reason, /requires a subcommand/i);
    // Lists the read-only subcommands so the caller can recover.
    assert.match(r.reason, /get/i);
  });

  it("subcommand match is case-insensitive", () => {
    assert.equal(classifyCommand("CONFIG", false, "GeT").allowed, true);
    assert.equal(classifyCommand("config", false, "set").kind, "write");
  });
});

describe("classifyCommand: fail-closed on unknown / dangerous commands", () => {
  it("rejects arbitrary-execution commands even with ALLOW_WRITES on", () => {
    for (const cmd of [
      "EVAL",
      "EVALSHA",
      "FUNCTION",
      "SCRIPT",
      "MULTI",
      "EXEC",
      "MONITOR",
      "SHUTDOWN",
      "CLUSTER",
      "DEBUG",
      "MIGRATE",
      "SWAPDB",
      "REPLICAOF",
    ]) {
      const r = classifyCommand(cmd, true);
      assert.equal(r.allowed, false, `${cmd} must stay blocked even with writes on`);
      assert.equal(r.kind, "unknown");
    }
  });

  it("rejects an empty command", () => {
    const r = classifyCommand("", false);
    assert.equal(r.allowed, false);
    assert.match(r.reason, /empty/i);
  });

  it("rejects a made-up command", () => {
    const r = classifyCommand("TOTALLYNOTACOMMAND", true);
    assert.equal(r.allowed, false);
    assert.equal(r.kind, "unknown");
    assert.match(r.reason, /not on the allowlist/i);
  });
});

describe("allowlist hygiene", () => {
  it("KEYS is not in the read-only allowlist (must go through SCAN)", () => {
    assert.equal(READONLY_COMMANDS.has("keys"), false);
  });

  it("read and write allowlists do not overlap", () => {
    const overlap = [...READONLY_COMMANDS].filter((c) => WRITE_COMMANDS.has(c));
    assert.deepEqual(overlap, [], `commands in both lists: ${overlap.join(", ")}`);
  });

  it("all allowlist entries are lowercase (classifier lowercases input)", () => {
    for (const c of [...READONLY_COMMANDS, ...WRITE_COMMANDS]) {
      assert.equal(c, c.toLowerCase(), `${c} should be lowercase in the allowlist`);
    }
  });
});
