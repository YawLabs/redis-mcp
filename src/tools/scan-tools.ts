import { z } from "zod";
import { formatRedisError, getClient, getMaxKeys, getScanCount } from "../api.js";
import { cursorSchema, matchPatternSchema } from "./params.js";
import { accumulateScan, deriveMaxIterations } from "./scan.js";

export const scanTools = [
  {
    name: "redis_scan",
    description:
      "Enumerate keys with cursor-based SCAN -- NEVER the O(N) KEYS command, so this is safe to " +
      "run against a production instance with millions of keys (SCAN yields the event loop " +
      "between batches). Returns up to REDIS_MAX_KEYS keys (default 1000) matching an optional " +
      "glob `match` pattern (e.g. `user:*`, `session:??`). When more keys remain, `truncated` is " +
      "true and `cursor` is non-'0' -- pass that `cursor` back to continue from where you left " +
      "off. Optionally filter by value `type` (string/list/set/zset/hash/stream). Within one call " +
      "duplicate keys are removed; across a resumed scan a key may reappear (SCAN's guarantee is " +
      "no key present for the whole scan is missed, not that none repeats).",
    annotations: {
      title: "Scan keys (SCAN, not KEYS)",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      match: matchPatternSchema
        .optional()
        .describe("Glob pattern to match keys (e.g. `user:*`). Omit to scan all keys."),
      cursor: cursorSchema.describe("SCAN cursor to resume from. Start (and default) is '0'."),
      type: z
        .enum(["string", "list", "set", "zset", "hash", "stream"])
        .optional()
        .describe("Filter to keys of this value type (uses SCAN's TYPE option)."),
      count: z
        .number()
        .int()
        .min(1)
        .max(10_000)
        .optional()
        .describe("COUNT hint per SCAN iteration (default REDIS_SCAN_COUNT=100). Higher = fewer round-trips."),
    }),
    handler: async (input: unknown) => {
      const { match, cursor, type, count } = input as {
        match?: string;
        cursor: string;
        type?: string;
        count?: number;
      };
      const maxKeys = getMaxKeys();
      const scanCount = count ?? getScanCount();
      const maxIterations = deriveMaxIterations(maxKeys, scanCount);

      try {
        const client = getClient();
        const result = await accumulateScan(
          cursor,
          async (cur) => {
            // ioredis scan(cursor, [MATCH pattern], [COUNT n], [TYPE t]) ->
            // [nextCursor, keys]. Build the variadic args conditionally.
            const args: (string | number)[] = [cur];
            if (match) args.push("MATCH", match);
            args.push("COUNT", scanCount);
            if (type) args.push("TYPE", type);
            const [nextCursor, keys] = (await client.scan(...(args as [string]))) as [string, string[]];
            return { cursor: nextCursor, keys };
          },
          { maxKeys, maxIterations },
        );

        return {
          ok: true,
          data: {
            keys: result.keys,
            count: result.keys.length,
            cursor: result.cursor,
            truncated: result.truncated,
            iterations: result.iterations,
            ...(result.truncated
              ? { _note: "More keys remain. Pass the returned `cursor` back to continue the scan." }
              : {}),
          },
        };
      } catch (err) {
        return { ok: false, error: formatRedisError(err) };
      }
    },
  },
] as const;
