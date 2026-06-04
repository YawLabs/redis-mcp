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
import { infoNum, parseInfo, parseKeyspace } from "./info.js";
import { accumulateScan, deriveMaxIterations } from "./scan.js";

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
      usedPctWarn: z
        .number()
        .min(0)
        .max(1)
        .default(0.8)
        .describe("Warn when used/maxmemory reaches this ratio (default 0.8 = 80%)."),
      forkUsecWarn: z
        .number()
        .int()
        .min(1)
        .default(100_000)
        .describe("Warn when the last fork took at least this many microseconds (default 100000 = 100ms)."),
      largeDatasetBytes: z
        .number()
        .int()
        .min(1)
        .default(1_073_741_824)
        .describe("Treat the dataset as large (fork-risk) at or above this many bytes (default 1 GiB = 1073741824)."),
    }),
    handler: async (input: unknown) => {
      const {
        sampleSize,
        bigKeyBytes,
        bigKeyElements,
        missingTtlFraction,
        usedPctWarn,
        forkUsecWarn,
        largeDatasetBytes,
      } = input as {
        sampleSize: number;
        bigKeyBytes: number;
        bigKeyElements: number;
        missingTtlFraction: number;
        usedPctWarn: number;
        forkUsecWarn: number;
        largeDatasetBytes: number;
      };
      try {
        const client = getClient();
        const rawInfo = await client.info();
        const info = parseInfo(rawInfo);

        // SCAN-sample up to sampleSize keys (never KEYS). We route through
        // accumulateScan (shared with redis_scan) so the iteration cap, the
        // "cursor=0" stop, and the within-call dedup all use the same well-
        // tested loop -- and so the response can surface a `truncated` flag
        // when the iteration cap trips (a large selective keyspace is the
        // common cause). NOTE: this draws from the first cursor pages, so
        // the sample is SCAN-order-biased, not a uniform-random draw.
        const sample: SampledKey[] = [];
        let probeFailures = 0;
        let scanTruncated = false;
        let scanIterations = 0;
        let scanMaxIterations = 0;
        if (sampleSize > 0) {
          const scanCount = getScanCount();
          const maxIterations = deriveMaxIterations(sampleSize, scanCount);
          scanMaxIterations = maxIterations;
          const scanned = await accumulateScan(
            "0",
            async (cur) => {
              const [next, keys] = (await client.scan(cur, "COUNT", scanCount)) as [string, string[]];
              return { cursor: next, keys };
            },
            { maxKeys: sampleSize, maxIterations },
          );
          scanTruncated = scanned.truncated;
          scanIterations = scanned.iterations;

          // Probe keys with bounded concurrency (~20 in flight) instead of one
          // serial round-trip at a time -- each probeKey is ~2 RTTs, so serial
          // probing of a 5000-key sample is ~10k serial RTTs. Order is
          // irrelevant: findBigKeys sorts, and missing-ttl is a fraction.
          //
          // Probe failures (the type/ttl/memory pipeline returned an error
          // for a key) are counted rather than sinking the whole sample.
          // Without this counter, a keyspace where MEMORY USAGE is ACL-
          // blocked (or any probe is failing wholesale) yields a sample of
          // all `type: 'none'`, and findMissingTtls escalates to "warn" on
          // 100% no-TTL -- a misleading false positive.
          const probeChunkSize = 20;
          for (let i = 0; i < scanned.keys.length; i += probeChunkSize) {
            const chunk = scanned.keys.slice(i, i + probeChunkSize);
            const probed = await Promise.all(chunk.map((k) => probeKey(client, k)));
            for (const p of probed) {
              sample.push(p);
              // A "failed" probe is one where the type was forced to "none"
              // AND the TTL defaulted to -2 (key missing / probe error) --
              // type: 'none' alone is a legitimate empty result, not an error.
              if (p.type === "none" && p.ttl === -2) probeFailures++;
            }
          }
        }

        const hasKeysWithoutTtl =
          sample.some((k) => k.ttl === -1) || parseKeyspace(info).some((db) => db.keys_without_ttl > 0);

        const bigKeys = findBigKeys(sample, { bigKeyBytes, bigKeyElements });
        const missingTtls = findMissingTtls(sample, missingTtlFraction);

        const evictionFacts: EvictionFacts = {
          maxmemoryBytes: infoNum(info, "maxmemory"),
          usedMemoryBytes: infoNum(info, "used_memory"),
          maxmemoryPolicy: info.maxmemory_policy ?? null,
          evictedKeys: infoNum(info, "evicted_keys"),
          hasKeysWithoutTtl,
        };
        const evictionPressure = findEvictionPressure(evictionFacts, usedPctWarn);

        const forkFacts: ForkLatencyFacts = {
          latestForkUsec: infoNum(info, "latest_fork_usec"),
          usedMemoryBytes: infoNum(info, "used_memory"),
          aofEnabled: info.aof_enabled === "1",
          rdbBgsaveInProgress: info.rdb_bgsave_in_progress === "1",
          rdbLastBgsaveStatus: info.rdb_last_bgsave_status ?? null,
        };
        const forkLatencyRisk = findForkLatencyRisk(forkFacts, forkUsecWarn, largeDatasetBytes);

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
            probe_failures: probeFailures,
            scan_truncated: scanTruncated,
            scan_iterations: scanIterations,
            scan_max_iterations: scanMaxIterations,
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
