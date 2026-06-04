import { z } from "zod";
import { formatRedisError, getClient, getMaxKeys, runCommand } from "../api.js";
import { keySchema } from "./params.js";

/**
 * Pull the value out of an ioredis pipeline reply at index `i`, tolerating both
 * a short/missing reply array and a per-probe error. ioredis pipeline.exec()
 * resolves to `[Error | null, unknown][] | null` -- each command yields an
 * `[err, value]` tuple so one probe failing (e.g. MEMORY USAGE on a server that
 * lacks it) doesn't sink the others. Returns null when the tuple is absent or
 * its error slot is non-null; otherwise the value cast to T.
 */
export function pickReply<T>(replies: [Error | null, unknown][] | null, i: number): T | null {
  if (!replies) return null;
  const tuple = replies[i];
  if (!tuple) return null;
  const [err, value] = tuple;
  if (err) return null;
  return value as T;
}

export const keyspaceTools = [
  {
    name: "redis_key_info",
    description:
      "Inspect a single key without reading its (possibly huge) value: type, TTL (seconds and " +
      "ms, -1 = no expiry, -2 = key missing), internal encoding (`listpack`, `hashtable`, " +
      "`intset`, ...), serialized memory footprint in bytes (MEMORY USAGE), and idle time. Use " +
      "this before `redis_get` on an unfamiliar key to avoid pulling a multi-megabyte value into " +
      "context, and to spot big keys / missing TTLs.",
    annotations: {
      title: "Inspect a key (type/TTL/encoding/memory)",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      key: keySchema.describe("The key to inspect."),
    }),
    handler: async (input: unknown) => {
      const { key } = input as { key: string };
      try {
        const client = getClient();
        // pipeline batches the probes into one round-trip. MEMORY USAGE and
        // OBJECT ENCODING can error on a missing key; ioredis pipeline returns
        // [err, value] tuples so a per-probe failure doesn't sink the others.
        const pipeline = client.pipeline();
        pipeline.type(key);
        pipeline.ttl(key);
        pipeline.pttl(key);
        pipeline.call("OBJECT", "ENCODING", key);
        pipeline.call("MEMORY", "USAGE", key);
        pipeline.call("OBJECT", "IDLETIME", key);
        const replies = await pipeline.exec();

        const type = pickReply<string>(replies, 0) ?? "none";
        if (type === "none") {
          return { ok: true, data: { key, exists: false } };
        }
        const ttlSeconds = pickReply<number>(replies, 1);
        return {
          ok: true,
          data: {
            key,
            exists: true,
            type,
            ttl_seconds: ttlSeconds,
            ttl_ms: pickReply<number>(replies, 2),
            has_expiry: ttlSeconds !== null && ttlSeconds >= 0,
            encoding: pickReply<string>(replies, 3),
            memory_usage_bytes: pickReply<number>(replies, 4),
            idle_time_seconds: pickReply<number>(replies, 5),
          },
        };
      } catch (err) {
        return { ok: false, error: formatRedisError(err) };
      }
    },
  },

  {
    name: "redis_get",
    description:
      "Read a key's value, dispatching by type so you get the right shape without knowing the " +
      "type in advance: string -> the string; hash -> field/value object; list -> array (LRANGE " +
      "windowed by `limit`); set -> member array; zset -> [member, score] pairs (ZRANGE " +
      "WITHSCORES, windowed); stream -> recent entries (XREVRANGE, windowed). Collection reads " +
      "are capped at `limit` (default REDIS_MAX_KEYS) so a million-element list can't blow out " +
      "context. Always read-only.",
    annotations: {
      title: "Read a key's value (type-aware)",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      key: keySchema.describe("The key to read."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100_000)
        .optional()
        .describe("Max elements to return for collection types (default REDIS_MAX_KEYS=1000)."),
    }),
    handler: async (input: unknown) => {
      const { key, limit } = input as { key: string; limit?: number };
      const cap = limit ?? getMaxKeys();
      try {
        const client = getClient();
        const type = await client.type(key);
        if (type === "none") {
          return { ok: true, data: { key, exists: false } };
        }

        switch (type) {
          case "string": {
            const value = await client.get(key);
            return { ok: true, data: { key, type, value } };
          }
          case "hash": {
            const total = await client.hlen(key);
            // HSCAN-bounded read so a million-field hash doesn't materialize fully.
            const fields: Record<string, string> = {};
            let count = 0;
            let cur = "0";
            do {
              const [next, batch] = await client.hscan(key, cur, "COUNT", 200);
              cur = next;
              // batch is a flat [field, value, field, value, ...] array.
              for (let i = 0; i + 1 < batch.length; i += 2) {
                if (count >= cap) break;
                fields[batch[i] as string] = batch[i + 1] as string;
                count++;
              }
            } while (cur !== "0" && count < cap);
            return { ok: true, data: { key, type, field_count: total, fields, truncated: total > count } };
          }
          case "list": {
            const total = await client.llen(key);
            // LRANGE end index is inclusive, so cap-1.
            const values = await client.lrange(key, 0, cap - 1);
            return { ok: true, data: { key, type, length: total, values, truncated: total > values.length } };
          }
          case "set": {
            const total = await client.scard(key);
            // SSCAN-bounded read so a huge set doesn't materialize fully.
            const members: string[] = [];
            let cur = "0";
            do {
              const [next, batch] = await client.sscan(key, cur, "COUNT", 200);
              cur = next;
              for (const m of batch) {
                if (members.length >= cap) break;
                members.push(m);
              }
            } while (cur !== "0" && members.length < cap);
            return { ok: true, data: { key, type, cardinality: total, members, truncated: total > members.length } };
          }
          case "zset": {
            const total = await client.zcard(key);
            const flat = await client.zrange(key, 0, cap - 1, "WITHSCORES");
            const pairs: { member: string; score: string }[] = [];
            for (let i = 0; i + 1 < flat.length; i += 2) {
              pairs.push({ member: flat[i] as string, score: flat[i + 1] as string });
            }
            return {
              ok: true,
              data: { key, type, cardinality: total, members: pairs, truncated: total > pairs.length },
            };
          }
          case "stream": {
            const total = await client.xlen(key);
            // XREVRANGE returns newest first; cap with COUNT.
            const entries = (await client.call("XREVRANGE", key, "+", "-", "COUNT", String(cap))) as unknown;
            const entryCount = Array.isArray(entries) ? entries.length : 0;
            return { ok: true, data: { key, type, length: total, entries, truncated: total > entryCount } };
          }
          default:
            return { ok: false, error: `Unsupported key type: ${type}` };
        }
      } catch (err) {
        return { ok: false, error: formatRedisError(err) };
      }
    },
  },

  {
    name: "redis_command",
    description:
      "Run a single Redis command through the safety gate. Read-only commands (GET, HGETALL, " +
      "LRANGE, TYPE, TTL, INFO, ...) always run. Mutating commands (SET, DEL, EXPIRE, HSET, ...) " +
      "require ALLOW_WRITES=1. KEYS is blocked (use redis_scan). Arbitrary-execution commands " +
      "(EVAL, FUNCTION, SCRIPT, MULTI, MONITOR, SHUTDOWN, CLUSTER, ...) are never exposed, even " +
      "with ALLOW_WRITES=1 -- the gate is a curated allowlist, not a blanket 'anything when " +
      "writes are on'. Use this for commands without a dedicated tool; prefer the typed tools " +
      "(redis_get, redis_scan, redis_key_info) where they exist.",
    annotations: {
      title: "Run a gated Redis command",
      // Conditionally destructive: a write command needs ALLOW_WRITES, but the
      // tool itself can issue mutations, so flag it for hosts that gate by hint.
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      command: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[A-Za-z]+$/, "Command must be a single alphabetic verb (e.g. GET, HGETALL); pass subcommands as args.")
        .describe("The Redis command verb (e.g. `GET`, `HGETALL`, `INFO`)."),
      args: z
        .array(z.union([z.string(), z.number()]))
        .default([])
        .describe("Command arguments in order. For multi-word commands, the subcommand is the first arg."),
    }),
    handler: async (input: unknown) => {
      const { command, args } = input as { command: string; args: (string | number)[] };
      // Forward the first arg as the subcommand so the classifier gates
      // multi-word commands correctly (CONFIG GET passes, CONFIG SET is a write).
      const subcommand = typeof args[0] === "string" ? args[0] : undefined;
      return runCommand(command, args, subcommand);
    },
  },
] as const;
