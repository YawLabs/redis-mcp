/**
 * Pure advisor heuristics. No I/O -- each function takes already-gathered facts
 * (parsed INFO fields, a sample of probed keys) and returns findings. Separated
 * from the handler so the threshold logic is unit-testable without a live Redis.
 *
 * Mirrors pg_advisor's "rolled-up DBA lint" shape: each heuristic is a category
 * with a list of findings and a short, actionable severity/why.
 */

export type Severity = "info" | "warn" | "critical";

export interface Finding {
  severity: Severity;
  message: string;
  /** Optional structured detail the message summarizes. */
  detail?: Record<string, unknown>;
}

/** A single sampled key with the facts the big-key / TTL heuristics need. */
export interface SampledKey {
  key: string;
  type: string;
  /** MEMORY USAGE bytes, or null if the probe failed. */
  memoryBytes: number | null;
  /** Element count for collections (llen/scard/zcard/hlen/xlen), null for strings or on failure. */
  elements: number | null;
  /** TTL in seconds: -1 = no expiry, -2 = missing (shouldn't appear in a fresh sample). */
  ttl: number;
}

export interface BigKeyThresholds {
  /** Flag a key whose MEMORY USAGE is at or above this many bytes. Default 1 MiB. */
  bigKeyBytes: number;
  /** Flag a collection with at least this many elements. Default 5000. */
  bigKeyElements: number;
}

/**
 * Big-key heuristic. A single large key (multi-MB value, or a collection with
 * tens of thousands of elements) is a latency and memory risk: every operation
 * that touches it is O(N), and DEL/EXPIRE on it can block the event loop.
 */
export function findBigKeys(sample: SampledKey[], t: BigKeyThresholds): Finding[] {
  const findings: Finding[] = [];
  for (const k of sample) {
    const bigBytes = k.memoryBytes !== null && k.memoryBytes >= t.bigKeyBytes;
    const bigElems = k.elements !== null && k.elements >= t.bigKeyElements;
    if (!bigBytes && !bigElems) continue;
    findings.push({
      severity: k.memoryBytes !== null && k.memoryBytes >= t.bigKeyBytes * 10 ? "critical" : "warn",
      message:
        `Big key "${k.key}" (${k.type}): ` +
        (k.memoryBytes !== null ? `${k.memoryBytes} bytes` : "size unknown") +
        (k.elements !== null ? `, ${k.elements} elements` : "") +
        ". Large keys make every operation on them O(N) and can block the event loop on delete/expire.",
      detail: { key: k.key, type: k.type, memory_bytes: k.memoryBytes, elements: k.elements },
    });
  }
  // Most dangerous first: critical before warn, then by memory bytes desc, then
  // element count desc -- so element-only-flagged keys (memory unknown -> 0) are
  // ranked by severity and size rather than sinking below every byte-flagged key.
  const sevRank = (s: Severity): number => (s === "critical" ? 0 : s === "warn" ? 1 : 2);
  findings.sort(
    (a, b) =>
      sevRank(a.severity) - sevRank(b.severity) ||
      Number(b.detail?.memory_bytes ?? 0) - Number(a.detail?.memory_bytes ?? 0) ||
      Number(b.detail?.elements ?? 0) - Number(a.detail?.elements ?? 0),
  );
  return findings;
}

/**
 * Missing-TTL heuristic. Keys without an expiry accumulate forever unless the
 * app deletes them explicitly -- the classic "Redis as a cache slowly fills up
 * and starts evicting / OOMs" failure. We report the share of the SAMPLE that
 * has no TTL; over `missingTtlFractionThreshold` (default 50%) is flagged.
 * Severity splits on the fraction: >= 0.9 -> warn, otherwise info.
 *
 * Distinct from the eviction-policy check: a `noeviction` policy + many
 * no-TTL keys is the dangerous combination (the instance OOMs instead of
 * shedding load), which the handler correlates.
 */
export function findMissingTtls(sample: SampledKey[], missingTtlFractionThreshold: number): Finding[] {
  if (sample.length === 0) return [];
  const noTtl = sample.filter((k) => k.ttl === -1);
  const fraction = noTtl.length / sample.length;
  if (fraction < missingTtlFractionThreshold) return [];
  return [
    {
      severity: fraction >= 0.9 ? "warn" : "info",
      message:
        `${noTtl.length} of ${sample.length} sampled keys (${(fraction * 100).toFixed(0)}%) have no TTL. ` +
        "Keys without an expiry never get reclaimed automatically; if this instance is used as a cache, " +
        "they will accumulate until maxmemory eviction or OOM. Set TTLs on cache keys, or confirm these " +
        "are intentional persistent keys.",
      detail: { sampled: sample.length, without_ttl: noTtl.length, fraction: Number(fraction.toFixed(3)) },
    },
  ];
}

export interface EvictionFacts {
  maxmemoryBytes: number | null;
  usedMemoryBytes: number | null;
  maxmemoryPolicy: string | null;
  evictedKeys: number | null;
  /** True if any sampled / keyspace key lacks a TTL (correlates with noeviction risk). */
  hasKeysWithoutTtl: boolean;
}

/**
 * Eviction-pressure heuristic. Three distinct signals:
 *   - used/maxmemory ratio approaching 1.0 -> close to the eviction/OOM wall.
 *   - evicted_keys > 0 -> eviction is actively happening (data loss for a cache,
 *     hard errors for a store).
 *   - maxmemory set + policy `noeviction` + keys without TTL -> when memory
 *     fills, writes start failing with OOM instead of shedding load. The most
 *     common production footgun.
 */
export function findEvictionPressure(f: EvictionFacts, usedPctWarnThreshold: number): Finding[] {
  const findings: Finding[] = [];

  if (f.maxmemoryBytes !== null && f.maxmemoryBytes > 0 && f.usedMemoryBytes !== null) {
    const pct = f.usedMemoryBytes / f.maxmemoryBytes;
    if (pct >= usedPctWarnThreshold) {
      findings.push({
        severity: pct >= 0.95 ? "critical" : "warn",
        message:
          `Memory at ${(pct * 100).toFixed(1)}% of maxmemory (${f.usedMemoryBytes} / ${f.maxmemoryBytes} bytes). ` +
          "Approaching the eviction/OOM wall.",
        detail: { used_bytes: f.usedMemoryBytes, maxmemory_bytes: f.maxmemoryBytes, pct: Number(pct.toFixed(3)) },
      });
    }
  }

  if (f.evictedKeys !== null && f.evictedKeys > 0) {
    findings.push({
      severity: "warn",
      message:
        `${f.evictedKeys} keys have been evicted (evicted_keys). Eviction is actively running -- ` +
        "data is being dropped to stay under maxmemory. If this is a data store (not a cache), that is data loss.",
      detail: { evicted_keys: f.evictedKeys, policy: f.maxmemoryPolicy },
    });
  }

  if (f.maxmemoryBytes !== null && f.maxmemoryBytes > 0 && f.maxmemoryPolicy === "noeviction" && f.hasKeysWithoutTtl) {
    findings.push({
      severity: "warn",
      message:
        "maxmemory is set with policy `noeviction` and keys without TTL exist. When memory fills, writes will " +
        "fail with OOM errors rather than evicting -- a hard outage. Either set TTLs, raise maxmemory, or switch " +
        "to an eviction policy (e.g. `allkeys-lru`) if this is a cache.",
      detail: { policy: f.maxmemoryPolicy, maxmemory_bytes: f.maxmemoryBytes },
    });
  }

  return findings;
}

export interface ForkLatencyFacts {
  /** From INFO latest_fork_usec: time the last fork (RDB save / AOF rewrite) took, in microseconds. */
  latestForkUsec: number | null;
  usedMemoryBytes: number | null;
  aofEnabled: boolean;
  rdbBgsaveInProgress: boolean;
  /** rdb_last_bgsave_status from INFO: "ok" on the last successful save, an error string otherwise (persistence broken). */
  rdbLastBgsaveStatus: string | null;
}

/**
 * Fork-latency risk heuristic. Redis forks the process for RDB snapshots and
 * AOF rewrites; on a large dataset the fork's copy-on-write page-table copy can
 * stall the main thread for hundreds of ms (worse with transparent huge pages).
 *   - latest_fork_usec high -> the last fork already stalled noticeably.
 *   - large dataset + persistence enabled -> future forks will be expensive.
 *   - last bgsave failed -> persistence is broken, a latent durability risk.
 */
export function findForkLatencyRisk(
  f: ForkLatencyFacts,
  forkUsecWarnThreshold: number,
  largeDatasetBytes: number,
): Finding[] {
  const findings: Finding[] = [];

  if (f.latestForkUsec !== null && f.latestForkUsec >= forkUsecWarnThreshold) {
    findings.push({
      severity: f.latestForkUsec >= forkUsecWarnThreshold * 5 ? "critical" : "warn",
      message:
        `The last fork (RDB save / AOF rewrite) took ${(f.latestForkUsec / 1000).toFixed(1)} ms ` +
        "(latest_fork_usec). During a fork the main thread stalls for the page-table copy; this is long enough " +
        "to cause visible latency spikes. Consider disabling transparent huge pages on the host and watching " +
        "this metric.",
      detail: { latest_fork_usec: f.latestForkUsec },
    });
  }

  // rdb_last_bgsave_status is near-always present in INFO (it reports "ok" even
  // when persistence is effectively off), so including it makes this a
  // deliberately INCLUSIVE (may over-warn) info-severity signal. We keep it
  // anyway: a default-config instance doing periodic RDB snapshots may have ONLY
  // this set, and dropping it would false-negative a real fork risk.
  const persistenceOn = f.aofEnabled || f.rdbBgsaveInProgress || f.rdbLastBgsaveStatus !== null;
  if (f.usedMemoryBytes !== null && f.usedMemoryBytes >= largeDatasetBytes && persistenceOn) {
    findings.push({
      severity: "info",
      message:
        `Dataset is large (${f.usedMemoryBytes} bytes) and persistence (RDB/AOF) appears active. Forks for ` +
        "snapshots/rewrites scale with dataset size and can stall the main thread. Ensure transparent huge " +
        "pages are disabled and that the host has enough free RAM for copy-on-write during a save.",
      detail: { used_bytes: f.usedMemoryBytes, aof_enabled: f.aofEnabled },
    });
  }

  if (f.rdbLastBgsaveStatus !== null && f.rdbLastBgsaveStatus !== "ok") {
    findings.push({
      severity: "critical",
      message:
        `The last background save failed (rdb_last_bgsave_status=${f.rdbLastBgsaveStatus}). Persistence is ` +
        "broken -- on restart the instance will lose everything since the last successful save. Check disk space " +
        "and the Redis log.",
      detail: { rdb_last_bgsave_status: f.rdbLastBgsaveStatus },
    });
  }

  return findings;
}
