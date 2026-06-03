import { z } from "zod";

/**
 * A Redis key (or key pattern). Redis itself imposes no hard length limit on
 * keys beyond the 512 MB string ceiling, but a key passed through an MCP tool
 * call that's megabytes long is always a mistake (and would bloat the model
 * context). Cap at a generous-but-sane 4096 bytes so an obviously-wrong input
 * is rejected at the call boundary with a clear error instead of being sent to
 * Redis. Byte length, not JS char length, because multi-byte keys are legal and
 * the cap is about wire/transport size.
 */
export const keySchema = z
  .string()
  .min(1)
  .refine((v) => Buffer.byteLength(v, "utf8") <= 4096, {
    message: "Key exceeds 4096 bytes. Redis keys can be larger, but a key this long through an MCP tool is unintended.",
  });

/**
 * A SCAN MATCH glob pattern (`user:*`, `session:??`, `*`). Same byte cap as a
 * key. Empty string is rejected -- pass `*` to match everything explicitly,
 * which is clearer than an empty pattern (and avoids ambiguity about whether
 * empty means "all" or "none").
 */
export const matchPatternSchema = z
  .string()
  .min(1)
  .refine((v) => Buffer.byteLength(v, "utf8") <= 4096, {
    message: "MATCH pattern exceeds 4096 bytes.",
  });

/**
 * A SCAN cursor. Redis cursors are unsigned 64-bit integers serialized as
 * decimal strings; "0" starts (and ends) a scan. We accept a digit string
 * rather than a number because a 64-bit cursor can exceed JS's safe-integer
 * range, and round-tripping it through a JS number would corrupt it. Validate
 * it's all digits so a malformed cursor is rejected before hitting Redis.
 */
export const cursorSchema = z
  .string()
  .regex(/^\d+$/, "Cursor must be a non-negative integer string (Redis SCAN cursor). Start a scan with '0'.")
  .default("0");
