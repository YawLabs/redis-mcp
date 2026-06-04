import { z } from "zod";
import { formatRedisError, getClient } from "../api.js";
import { infoNum, parseInfo, parseKeyspace, parseSlowlog, type SlowlogEntry } from "./info.js";

export const healthTools = [
  {
    name: "redis_health",
    description:
      "One-call health snapshot rolled up from INFO + DBSIZE + recent SLOWLOG: server version and " +
      "mode, uptime, memory used vs maxmemory + eviction policy, connected clients + blocked " +
      "clients, ops/sec, keyspace hit/miss ratio, total keys per database (and how many lack a " +
      "TTL), persistence (RDB/AOF) status, replication role, and the most recent slow commands. " +
      "Use as a connection sanity check and the first stop in 'why is Redis slow / using so much " +
      "memory?' triage.",
    annotations: {
      title: "Redis health snapshot",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      slowlogLimit: z
        .number()
        .int()
        .min(0)
        .max(100)
        .default(5)
        .describe("Number of recent slow commands to include (default 5, 0 to skip)."),
    }),
    handler: async (input: unknown) => {
      const { slowlogLimit } = input as { slowlogLimit: number };
      try {
        const client = getClient();
        // Batch the probes into one pipeline round-trip. Each is read-only.
        const pipeline = client.pipeline();
        pipeline.info();
        pipeline.dbsize();
        if (slowlogLimit > 0) pipeline.call("SLOWLOG", "GET", String(slowlogLimit));
        const replies = (await pipeline.exec()) ?? [];

        // If INFO itself failed, connectivity is broken -- surface directly.
        const infoTuple = replies[0];
        if (!infoTuple || infoTuple[0]) {
          return { ok: false, error: formatRedisError(infoTuple?.[0] ?? new Error("INFO returned no data")) };
        }
        const info = parseInfo(String(infoTuple[1] ?? ""));

        const warnings: string[] = [];
        const dbsizeTuple = replies[1];
        let dbsize: number | null = null;
        if (dbsizeTuple && !dbsizeTuple[0]) {
          const n = Number(dbsizeTuple[1]);
          dbsize = Number.isFinite(n) ? n : null;
        }
        if (dbsizeTuple?.[0]) warnings.push(`dbsize fetch failed: ${formatRedisError(dbsizeTuple[0])}`);

        let slowlog: SlowlogEntry[] = [];
        if (slowlogLimit > 0) {
          const slowTuple = replies[2];
          if (slowTuple && !slowTuple[0]) {
            slowlog = parseSlowlog(slowTuple[1]);
          } else if (slowTuple?.[0]) {
            warnings.push(`slowlog fetch failed: ${formatRedisError(slowTuple[0])}`);
          }
        }

        const hits = infoNum(info, "keyspace_hits");
        const misses = infoNum(info, "keyspace_misses");
        const hitRate =
          hits !== null && misses !== null && hits + misses > 0
            ? Number(((hits / (hits + misses)) * 100).toFixed(2))
            : null;

        const maxmemory = infoNum(info, "maxmemory");
        const usedMemory = infoNum(info, "used_memory");
        const memoryPctOfMax =
          maxmemory !== null && maxmemory > 0 && usedMemory !== null
            ? Number(((usedMemory / maxmemory) * 100).toFixed(2))
            : null;

        return {
          ok: true,
          data: {
            connected: true,
            server: {
              version: info.redis_version ?? null,
              mode: info.redis_mode ?? null,
              role: info.role ?? null,
              uptime_seconds: infoNum(info, "uptime_in_seconds"),
            },
            memory: {
              used_bytes: usedMemory,
              used_human: info.used_memory_human ?? null,
              peak_bytes: infoNum(info, "used_memory_peak"),
              maxmemory_bytes: maxmemory,
              maxmemory_human: info.maxmemory_human ?? null,
              maxmemory_policy: info.maxmemory_policy ?? null,
              pct_of_maxmemory: memoryPctOfMax,
              mem_fragmentation_ratio: infoNum(info, "mem_fragmentation_ratio"),
              evicted_keys: infoNum(info, "evicted_keys"),
            },
            clients: {
              connected: infoNum(info, "connected_clients"),
              blocked: infoNum(info, "blocked_clients"),
              maxclients: infoNum(info, "maxclients"),
            },
            throughput: {
              instantaneous_ops_per_sec: infoNum(info, "instantaneous_ops_per_sec"),
              total_commands_processed: infoNum(info, "total_commands_processed"),
              keyspace_hits: hits,
              keyspace_misses: misses,
              hit_rate_pct: hitRate,
            },
            persistence: {
              rdb_last_save_time: infoNum(info, "rdb_last_save_time"),
              rdb_changes_since_last_save: infoNum(info, "rdb_changes_since_last_save"),
              rdb_last_bgsave_status: info.rdb_last_bgsave_status ?? null,
              aof_enabled: info.aof_enabled === "1",
              aof_last_write_status: info.aof_last_write_status ?? null,
            },
            keyspace: {
              total_keys: dbsize,
              per_db: parseKeyspace(info),
            },
            slowlog,
            ...(warnings.length > 0 ? { _warnings: warnings } : {}),
          },
        };
      } catch (err) {
        return { ok: false, error: formatRedisError(err) };
      }
    },
  },

  {
    name: "redis_slowlog",
    description:
      "Recent entries from the Redis slow log -- commands that took longer than " +
      "`slowlog-log-slower-than` microseconds (default 10000 = 10ms). Each entry has the command, " +
      "execution time in microseconds, a unix timestamp, and the client address/name (Redis 4+). " +
      "The fastest way to find which specific commands are slow. Read-only (SLOWLOG GET); " +
      "SLOWLOG RESET would need ALLOW_WRITES and is intentionally not exposed here.",
    annotations: {
      title: "Recent slow commands",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      limit: z.number().int().min(1).max(128).default(20).describe("Max slowlog entries to return (default 20)."),
    }),
    handler: async (input: unknown) => {
      const { limit } = input as { limit: number };
      try {
        const client = getClient();
        const raw = await client.call("SLOWLOG", "GET", String(limit));
        const entries = parseSlowlog(raw);
        return { ok: true, data: { entries, count: entries.length } };
      } catch (err) {
        return { ok: false, error: formatRedisError(err) };
      }
    },
  },
] as const;
