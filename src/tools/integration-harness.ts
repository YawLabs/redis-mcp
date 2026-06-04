/**
 * Shared helpers for the *.integration.test.ts files. These tests drive the
 * real tool handlers against a LIVE Redis -- the handlers call getClient(),
 * which reads REDIS_URL, so the integration boundary is exercised for real
 * (no mocking of the ioredis client).
 *
 * When REDIS_URL is unset the suite skips cleanly (the runner treats a
 * --integration run with zero applicable tests as a no-op, and node:test marks
 * skipped tests as such rather than failing).
 *
 * NOTE: this file deliberately has no `.test.` in its name so the test runner
 * (scripts/run-tests.mjs) does NOT execute it directly -- it is imported by the
 * integration test files.
 */

import { Redis } from "ioredis";

/** The live Redis URL the suite connects to, or undefined when integration is off. */
export const REDIS_URL = process.env.REDIS_URL?.trim() || undefined;

/** True when integration tests should run; false -> every test is skipped. */
export const HAVE_REDIS = REDIS_URL !== undefined;

/**
 * A node:test skip reason string when Redis is absent. Passing
 * `{ skip: skipReason() }` to `it()` marks the test skipped (not failed) and
 * surfaces the reason in TAP output.
 */
export function skipReason(): string | false {
  return HAVE_REDIS ? false : "REDIS_URL not set -- integration test skipped (start a redis and set REDIS_URL)";
}

/**
 * A raw seed client, separate from the handler's singleton, used to write
 * fixtures and to clean up. Built lazily so importing this module without a
 * live Redis (the skip path) never opens a socket.
 */
let seedClient: Redis | null = null;
export function getSeedClient(): Redis {
  if (!HAVE_REDIS) throw new Error("getSeedClient called without REDIS_URL");
  if (seedClient) return seedClient;
  seedClient = new Redis(REDIS_URL as string, {
    lazyConnect: false,
    maxRetriesPerRequest: 1,
  });
  seedClient.on("error", () => {
    /* swallow -- connectivity failures surface on the first command */
  });
  return seedClient;
}

export async function closeSeedClient(): Promise<void> {
  if (!seedClient) return;
  const c = seedClient;
  seedClient = null;
  try {
    await c.quit();
  } catch {
    c.disconnect();
  }
}

/**
 * Delete every key matching `prefix*` via SCAN (never KEYS) so test runs don't
 * leak fixtures into the target instance. Safe to call when the prefix matches
 * nothing. DEL is chunked at 500 keys/call so a large leftover fixture can't
 * trip maxmemory mid-cleanup (one big DEL batch can OOM a constrained test
 * instance).
 */
export async function cleanupPrefix(client: Redis, prefix: string): Promise<void> {
  let cursor = "0";
  do {
    const [next, keys] = (await client.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 500)) as [string, string[]];
    cursor = next;
    for (let i = 0; i < keys.length; i += 500) {
      const chunk = keys.slice(i, i + 500);
      if (chunk.length > 0) await client.del(...chunk);
    }
  } while (cursor !== "0");
}

/** True when the connected server supports Redis Streams (XADD/XLEN/XREVRANGE), i.e. Redis 5+. */
export async function supportsStreams(client: Redis): Promise<boolean> {
  try {
    // XADD on a throwaway key; if the verb is unknown we're on an ancient build.
    const probe = `__redis_mcp_stream_probe__:${Date.now()}`;
    await client.xadd(probe, "*", "f", "v");
    await client.del(probe);
    return true;
  } catch {
    return false;
  }
}

/** True when the server supports MEMORY USAGE (Redis 4+). */
export async function supportsMemoryUsage(client: Redis): Promise<boolean> {
  try {
    const probe = `__redis_mcp_mem_probe__:${Date.now()}`;
    await client.set(probe, "x");
    await client.call("MEMORY", "USAGE", probe);
    await client.del(probe);
    return true;
  } catch {
    return false;
  }
}
