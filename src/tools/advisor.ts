import { z } from "zod";
import { formatRedisError, getClient, getScanCount } from "../api.js";
import {
  type EvictionFacts,
  type Finding,
  type ForkLatencyFacts,
  findBigKeys,
  findEvictionPressure,
  findForkLatencyRisk,
  findMissingTtls,
  type SampledKey,
} from "./advisor-heuristics.js";
import { parseInfo } from "./info.js";

function num(info: Record<string, string>, field: string): number | null {
  const v = info[field];
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Probe one sampled key for the facts the heuristics need: type, TTL, memory
 * footprint, and element count. Best-effort -- a per-probe failure yields nulls
 * rather than sinking the whole sample.
 */
async function probeKey(client: ReturnType<typeof getClient>, key: string): Promise<SampledKey> {
  const pipeline = client.pipeline();
  pipeline.type(key);
  pipeline.ttl(key);
  pipeline.call("MEMORY", "USAGE", key);
  const replies = (await pipeline.exec()) ?? [];
  const get = <T>(i: number): T | null => {
    const t = replies[i];
    if (!t || t[0]) return null;
    return t[1] as T;
  };
  const type = get<string>(0) ?? "none";
  const ttl = get<number>(1) ?? -2;
  const memoryBytes = get<number>(2);

  // Element count is type-specific; one more round-trip only for collections.
  let elements: number | null = null;
  try {
    switch (type) {
      case "list":
        elements = await client.llen(key);
        break;
      case "set":
        elements = await client.scard(key);
        break;
      case "zset":
        elements = await client.zcard(key);
        break;
      case "hash":
        elements = await client.hlen(key);
        break;
      case "stream":
        elements = await client.xlen(key);
        break;
      default:
        elements = null;
    }
  } catch {
    elements = null;
  }
  return { key, type, memoryBytes, elements, ttl };
}

export const advisorTools = [
  {
    name: "redis_advisor",
    description:
      "Rolled-up Redis health lint pass -- one call returns four categories of findings, each with " +
      "a severity and an actionable fix:\n" +
      "- big_keys: sampled keys whose memory footprint or element count is large enough to make " +
      "operations O(N) and risk blocking the event loop on delete/expire.\n" +
      "- missing_ttls: share of sampled keys with no expiry -- the classic 'cache fills up and " +
      "OOMs' setup.\n" +
      "- eviction_pressure: used/maxmemory ratio, active evictions, and the dangerous " +
      "`noeviction` + no-TTL combination that turns a full instance into failed writes.\n" +
      "- fork_latency_risk: long last-fork time, large dataset + active persistence, and failed " +
      "background saves -- the causes of periodic latency spikes and durability gaps.\n" +
      "Keys are sampled via SCAN (never KEYS), so it is safe on a large production instance; the " +
      "big-key / missing-TTL findings are over the SAMPLE, not the whole keyspace.",
    annotations: {
      title: "Redis advisor (health lints)",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      sampleSize: z
        .number()
        .int()
        .min(0)
        .max(5000)
        .default(200)
        .describe(
          "How many keys to SCAN-sample for big-key / missing-TTL checks (default 200, 0 to skip key sampling).",
        ),
      bigKeyBytes: z
        .number()
        .int()
        .min(1)
        .default(1_048_576)
        .describe("Flag a key at or above this many bytes (default 1 MiB = 1048576)."),
      bigKeyElements: z
        .number()
        .int()
        .min(1)
        .default(5000)
        .describe("Flag a collection with at least this many elements (default 5000)."),
      missingTtlFraction: z
        .number()
        .min(0)
        .max(1)
        .default(0.5)
        .describe("Flag when this fraction of the sample lacks a TTL (default 0.5 = 50%)."),
    }),
    handler: async (input: unknown) => {
      const { sampleSize, bigKeyBytes, bigKeyElements, missingTtlFraction } = input as {
        sampleSize: number;
        bigKeyBytes: number;
        bigKeyElements: number;
        missingTtlFraction: number;
      };
      try {
        const client = getClient();
        const rawInfo = await client.info();
        const info = parseInfo(rawInfo);

        // SCAN-sample up to sampleSize keys (never KEYS). Bounded iterations so
        // an empty/small keyspace returns promptly.
        const sample: SampledKey[] = [];
        if (sampleSize > 0) {
          const scanCount = getScanCount();
          let cursor = "0";
          let iterations = 0;
          const sampledKeys: string[] = [];
          do {
            const [next, keys] = (await client.scan(cursor, "COUNT", scanCount)) as [string, string[]];
            cursor = next;
            iterations++;
            for (const k of keys) {
              if (sampledKeys.length >= sampleSize) break;
              sampledKeys.push(k);
            }
          } while (cursor !== "0" && sampledKeys.length < sampleSize && iterations < sampleSize + 50);

          for (const k of sampledKeys) {
            sample.push(await probeKey(client, k));
          }
        }

        const hasKeysWithoutTtl = sample.some((k) => k.ttl === -1);

        const bigKeys = findBigKeys(sample, { bigKeyBytes, bigKeyElements });
        const missingTtls = findMissingTtls(sample, missingTtlFraction);

        const evictionFacts: EvictionFacts = {
          maxmemoryBytes: num(info, "maxmemory"),
          usedMemoryBytes: num(info, "used_memory"),
          maxmemoryPolicy: info.maxmemory_policy ?? null,
          evictedKeys: num(info, "evicted_keys"),
          hasKeysWithoutTtl,
        };
        const evictionPressure = findEvictionPressure(evictionFacts, 0.8);

        const forkFacts: ForkLatencyFacts = {
          latestForkUsec: num(info, "latest_fork_usec"),
          usedMemoryBytes: num(info, "used_memory"),
          aofEnabled: info.aof_enabled === "1",
          rdbBgsaveInProgress: info.rdb_bgsave_in_progress === "1",
          rdbLastBgsaveStatus: info.rdb_last_bgsave_status ?? null,
        };
        // 100ms fork warn threshold; 1 GiB "large dataset" threshold.
        const forkLatencyRisk = findForkLatencyRisk(forkFacts, 100_000, 1_073_741_824);

        const allFindings: Finding[] = [...bigKeys, ...missingTtls, ...evictionPressure, ...forkLatencyRisk];
        const counts = {
          critical: allFindings.filter((f) => f.severity === "critical").length,
          warn: allFindings.filter((f) => f.severity === "warn").length,
          info: allFindings.filter((f) => f.severity === "info").length,
        };

        return {
          ok: true,
          data: {
            sampled_keys: sample.length,
            summary: counts,
            big_keys: bigKeys,
            missing_ttls: missingTtls,
            eviction_pressure: evictionPressure,
            fork_latency_risk: forkLatencyRisk,
          },
        };
      } catch (err) {
        return { ok: false, error: formatRedisError(err) };
      }
    },
  },
] as const;
