/**
 * Command allowlist + classifier. PURE logic, no I/O -- unit-testable without a
 * live Redis.
 *
 * The safety model mirrors postgres-mcp's read-first posture: instead of a
 * `BEGIN READ ONLY` transaction (Redis has no such thing), we gate on the
 * command name. A curated set of commands is known read-only and always
 * allowed; a curated set is known-mutating and allowed only when ALLOW_WRITES=1;
 * everything else is rejected (fail-closed) so an unrecognized or newly-added
 * dangerous command can never slip through by default.
 */

/**
 * Read-only Redis commands the server will always run, regardless of
 * ALLOW_WRITES. Deliberately conservative: introspection, single-key reads,
 * range/probe reads, and the diagnostic surface.
 *
 * NOTE: subcommand-gated verbs (CONFIG, CLIENT, MEMORY, SLOWLOG, ACL, LATENCY,
 * COMMAND, OBJECT, XINFO) are deliberately NOT listed here -- they are gated
 * SOLELY by READONLY_SUBCOMMANDS so that only their read-only subcommands pass
 * (CONFIG GET ok, CONFIG SET gated). Listing a verb in BOTH sets would be dead
 * code AND a fail-open footgun: classifyCommand consults READONLY_SUBCOMMANDS
 * first, so a future edit dropping a verb from that map would silently let ALL
 * its subcommands (including writes) through as a bare read via this set. A
 * hygiene test (commands.test.ts) asserts the two sets stay disjoint.
 *
 * NOTE: `KEYS` is deliberately ABSENT. Key enumeration goes through SCAN only
 * (see scan.ts) -- KEYS is O(N) and blocks the single-threaded event loop.
 */
export const READONLY_COMMANDS: ReadonlySet<string> = new Set([
  // server / keyspace introspection
  "scan",
  "hscan",
  "sscan",
  "zscan",
  "type",
  "ttl",
  "pttl",
  "exists",
  "dbsize",
  "randomkey",
  "dump",
  "touch", // updates only LRU/LFU access time, not the value -- treated read-ish
  // string reads
  "get",
  "getrange",
  "strlen",
  "mget",
  "substr",
  "bitcount",
  "bitpos",
  "getbit",
  // hash reads
  "hget",
  "hmget",
  "hgetall",
  "hkeys",
  "hvals",
  "hlen",
  "hexists",
  "hstrlen",
  "hrandfield",
  // list reads
  "lrange",
  "lindex",
  "llen",
  "lpos",
  // set reads
  "smembers",
  "sismember",
  "smismember",
  "scard",
  "srandmember",
  "sinter",
  "sunion",
  "sdiff",
  // sorted-set reads
  "zrange",
  "zrangebyscore",
  "zrangebylex",
  "zrevrange",
  "zrevrangebyscore",
  "zrevrangebylex",
  "zcard",
  "zscore",
  "zmscore",
  "zrank",
  "zrevrank",
  "zcount",
  "zlexcount",
  "zrandmember",
  // stream reads
  "xrange",
  "xrevrange",
  "xlen",
  "xpending",
  // diagnostics / health (subcommand-gated verbs like MEMORY/SLOWLOG/CLIENT/
  // CONFIG/ACL/LATENCY/COMMAND live in READONLY_SUBCOMMANDS, NOT here)
  "info",
  "ping",
  "time",
  "lastsave",
  "lolwut",
  "echo",
  "expiretime",
  "pexpiretime",
  // probabilistic / geo / misc reads. The mutating siblings (PFADD, PFMERGE,
  // GEOADD, GEOSEARCHSTORE, GEORADIUS ... STORE, SORT ... STORE, BITFIELD with
  // SET/INCRBY) are intentionally absent; only the pure-read verbs (and the
  // explicit *_RO variants) are listed.
  "pfcount",
  "geosearch",
  "geopos",
  "geodist",
  "geohash",
  "georadius_ro",
  "georadiusbymember_ro",
  "sintercard",
  "lcs",
  "sort_ro",
  "bitfield_ro",
]);

/**
 * For the handful of multi-word commands above whose SUBCOMMAND determines
 * whether the call is read-only, list the read-only subcommands explicitly.
 * If a command is in this map, only the listed subcommands are read-only; any
 * other subcommand (e.g. `CONFIG SET`, `SLOWLOG RESET`, `CLIENT KILL`,
 * `MEMORY PURGE`, `ACL SETUSER`) is treated as a write and gated.
 */
export const READONLY_SUBCOMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["config", new Set(["get"])],
  ["slowlog", new Set(["get", "len"])],
  ["client", new Set(["list", "info", "getname", "id", "no-evict", "no-touch"])],
  ["command", new Set(["count", "docs", "info", "getkeys", "list"])],
  ["object", new Set(["encoding", "freq", "idletime", "refcount", "help"])],
  ["memory", new Set(["usage", "stats", "doctor", "malloc-stats"])],
  ["acl", new Set(["cat", "getuser", "list", "users", "whoami"])],
  ["latency", new Set(["latest", "history", "doctor", "graph"])],
  ["xinfo", new Set(["stream", "groups", "consumers", "help"])],
]);

/**
 * Commands that mutate state. Allowed only when ALLOW_WRITES=1. This list is
 * NOT exhaustive of every Redis write command -- the classifier rejects unknown
 * commands regardless -- but naming the common writes lets the error message
 * distinguish "known write, needs ALLOW_WRITES" from "unknown command,
 * rejected outright", which is more actionable for an agent.
 */
export const WRITE_COMMANDS: ReadonlySet<string> = new Set([
  "set",
  "setex",
  "setnx",
  "psetex",
  "setrange",
  "append",
  "getset",
  "getdel",
  "getex",
  "mset",
  "msetnx",
  "incr",
  "incrby",
  "incrbyfloat",
  "decr",
  "decrby",
  "setbit",
  "del",
  "unlink",
  "expire",
  "pexpire",
  "expireat",
  "pexpireat",
  "persist",
  "rename",
  "renamenx",
  "move",
  "copy",
  "restore",
  "hset",
  "hsetnx",
  "hmset",
  "hincrby",
  "hincrbyfloat",
  "hdel",
  "lpush",
  "rpush",
  "lpushx",
  "rpushx",
  "lpop",
  "rpop",
  "lset",
  "linsert",
  "lrem",
  "ltrim",
  "rpoplpush",
  "lmove",
  "sadd",
  "srem",
  "spop",
  "smove",
  "sinterstore",
  "sunionstore",
  "sdiffstore",
  "zadd",
  "zincrby",
  "zrem",
  "zremrangebyrank",
  "zremrangebyscore",
  "zremrangebylex",
  "zpopmin",
  "zpopmax",
  "xadd",
  "xdel",
  "xtrim",
  "xsetid",
  "xgroup",
  "xack",
  "xclaim",
  "xautoclaim",
  "flushdb",
  "flushall",
]);

export interface ClassifyResult {
  allowed: boolean;
  /** "read" | "write" | "unknown" | "incomplete" -- the classification, present even when allowed=false. */
  kind: "read" | "write" | "unknown" | "incomplete";
  reason: string;
}

/**
 * Classify a Redis command (with its optional subcommand as the first arg) into
 * read / write / unknown, and decide whether it may run given `writesAllowed`.
 *
 * @param command   the command verb, case-insensitive (e.g. "GET", "config")
 * @param writesAllowed  whether ALLOW_WRITES is enabled
 * @param subcommand     the first argument, used only for multi-word commands
 *                       in READONLY_SUBCOMMANDS (e.g. "get" for "CONFIG GET").
 *                       Case-insensitive.
 *
 * Fail-closed: a command in neither allowlist is `unknown` and rejected, so a
 * dangerous command we forgot to list never runs by default. The caller can
 * still reach any command through the explicit raw-command tool, which routes
 * here -- there is no bypass.
 */
export function classifyCommand(command: string, writesAllowed: boolean, subcommand?: string): ClassifyResult {
  const verb = command.trim().toLowerCase();
  const sub = subcommand?.trim().toLowerCase();

  if (verb === "") {
    return { allowed: false, kind: "unknown", reason: "Empty command." };
  }

  // KEYS is explicitly refused with a SCAN nudge -- it's a read, but a
  // dangerous one (O(N), blocks the event loop). Steer the agent to the
  // scan-based tools instead of silently allowing it.
  if (verb === "keys") {
    return {
      allowed: false,
      kind: "read",
      reason:
        "KEYS is blocked: it is O(N) over the entire keyspace and blocks Redis's single-threaded event loop. " +
        "Use the redis_scan tool (cursor-based SCAN) to enumerate keys safely.",
    };
  }

  // Multi-word commands whose read-only-ness depends on the subcommand.
  const roSubs = READONLY_SUBCOMMANDS.get(verb);
  if (roSubs) {
    // No subcommand given on a command that requires one (e.g. bare "CONFIG"):
    // treat as a read probe attempt but reject for ambiguity rather than guess.
    if (sub === undefined || sub === "") {
      return {
        allowed: false,
        kind: "incomplete",
        reason: `${verb.toUpperCase()} requires a subcommand. Read-only subcommands: ${[...roSubs].join(", ")}.`,
      };
    }
    if (roSubs.has(sub)) {
      return { allowed: true, kind: "read", reason: "read-only" };
    }
    // A non-read subcommand of an otherwise-listed command (CONFIG SET,
    // SLOWLOG RESET, CLIENT KILL, MEMORY PURGE, ACL SETUSER, ...). This is a
    // write; gate it.
    if (!writesAllowed) {
      return {
        allowed: false,
        kind: "write",
        reason:
          `${verb.toUpperCase()} ${sub.toUpperCase()} mutates state and is blocked: ALLOW_WRITES is not set. ` +
          "Set ALLOW_WRITES=1 in the MCP server env to enable it.",
      };
    }
    return { allowed: true, kind: "write", reason: "write allowed" };
  }

  if (READONLY_COMMANDS.has(verb)) {
    return { allowed: true, kind: "read", reason: "read-only" };
  }

  if (WRITE_COMMANDS.has(verb)) {
    if (!writesAllowed) {
      return {
        allowed: false,
        kind: "write",
        reason:
          `${verb.toUpperCase()} mutates state and is blocked: ALLOW_WRITES is not set. ` +
          "Set ALLOW_WRITES=1 in the MCP server env to enable DML.",
      };
    }
    return { allowed: true, kind: "write", reason: "write allowed" };
  }

  // Fail-closed. Includes EVAL/EVALSHA/FCALL (arbitrary Lua/functions),
  // SCRIPT, FUNCTION, MULTI/EXEC, SUBSCRIBE, MONITOR, DEBUG, SHUTDOWN, SAVE,
  // BGREWRITEAOF, REPLICAOF, CLUSTER, MIGRATE, SWAPDB, and anything else not
  // explicitly classified. Even with ALLOW_WRITES=1 these stay blocked -- the
  // gate is a curated write allowlist, not "anything when writes are on".
  return {
    allowed: false,
    kind: "unknown",
    reason:
      `${verb.toUpperCase()} is not on the allowlist and is blocked. This server runs a curated set of ` +
      "read-only commands (and curated writes when ALLOW_WRITES=1). Commands like EVAL, FUNCTION, SCRIPT, " +
      "MULTI, MONITOR, SHUTDOWN, and CLUSTER are intentionally not exposed.",
  };
}
