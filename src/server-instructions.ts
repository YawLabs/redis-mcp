/**
 * The MCP `instructions` string this server hands its host: which tool to
 * reach for, nothing else. Plain ASCII, routing guidance only -- behavioural
 * detail lives in the tool descriptions, which load with the tools.
 *
 * yaw-mcp, which fronts this server for many of its users, captures an
 * upstream's instructions, cuts them at 2000 UTF-8 bytes
 * (MAX_UPSTREAM_INSTRUCTIONS_BYTES in its src/upstream-instructions.ts) and
 * renders them once per session in the activate/dispatch reply. Without them
 * that routing fence is empty, and the read-only default and the SCAN-not-KEYS
 * rule live only in individual tool descriptions. src/server-instructions.test.ts
 * holds the text to SERVER_INSTRUCTIONS_CAP_BYTES, to ASCII, and to the real
 * tool list.
 */

/** yaw-mcp's per-server instructions ceiling, in UTF-8 bytes. */
export const SERVER_INSTRUCTIONS_CAP_BYTES = 2000;

export const SERVER_INSTRUCTIONS = [
  "Read-first Redis / Valkey explorer. Every tool is read-only unless the server was started with ALLOW_WRITES=1, which unlocks only curated mutating commands through redis_command; EVAL, MULTI, MONITOR, CLUSTER and other arbitrary-execution commands stay blocked either way.",
  "Start with redis_health (no arguments needed) to check connectivity and get memory, eviction, hit rate, persistence and the recent slow commands in one call.",
  "To find keys use redis_scan and resume with the cursor it returns; never ask redis_command for KEYS, which is blocked.",
  "Before reading a key of unknown size, call redis_key_info (type, TTL, encoding, memory) and then redis_get, which windows large values and collections.",
  "For 'what should I worry about on this instance', use redis_advisor. For slow commands alone, redis_slowlog. For any other single command, redis_command.",
].join("\n");
