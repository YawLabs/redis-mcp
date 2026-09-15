/**
 * Redis connection (singleton ioredis client) with read-first enforcement.
 *
 * Config:
 *   - REDIS_URL                        - redis connection string (required), e.g.
 *                                        redis://:pass@host:6379/0 or rediss://... for TLS
 *   - ALLOW_WRITES                     - set to "1" or "true" to allow mutating
 *                                        commands (default: read-only)
 *   - REDIS_COMMAND_TIMEOUT_MS         - per-command timeout (default: 10000). A
 *                                        command that runs longer is aborted so a
 *                                        wedged call can't hang the agent.
 *   - REDIS_CONNECT_TIMEOUT_MS         - TCP connect timeout (default: 10000).
 *                                        Without this, a dead host hangs until the
 *                                        OS gives up (~2 minutes on most platforms).
 *
 * Timeout note: the FIRST tool call against an unreachable host is bounded by
 * connectTimeout (REDIS_CONNECT_TIMEOUT_MS), not commandTimeout -- the TCP
 * connect is deferred (lazyConnect) and runs as part of that first call, and it
 * may attempt one reconnect via retryStrategy before failing. commandTimeout
 * (REDIS_COMMAND_TIMEOUT_MS) governs commands on an already-connected client.
 *   - REDIS_MAX_KEYS                   - max keys returned by a single scan tool call
 *                                        (default: 1000). Caps both the response size
 *                                        and the number of SCAN iterations.
 *   - REDIS_SCAN_COUNT                 - COUNT hint per SCAN iteration (default: 100).
 *                                        A larger value scans more keys per round-trip
 *                                        but holds the Redis event loop slightly longer
 *                                        each iteration.
 *   - REDIS_MAX_VALUE_BYTES            - max bytes of a string value redis_get returns
 *                                        before windowing it with GETRANGE (default:
 *                                        262144 = 256 KiB). Keeps a multi-MB string from
 *                                        flooding the model context; sets `truncated`.
 *   - REDIS_TLS_REJECT_UNAUTHORIZED    - "false" to disable TLS cert verification --
 *                                        the chain AND the hostname check. The
 *                                        connection is still encrypted, but no longer
 *                                        authenticated; for a private CA, prefer
 *                                        NODE_EXTRA_CA_CERTS.
 *
 * Safety model:
 *   The server issues a read-only command allowlist by default (see
 *   commands.ts). Mutating commands are rejected with a clear "set ALLOW_WRITES=1"
 *   hint before they ever reach Redis. Enable writes via ALLOW_WRITES=1. Key
 *   enumeration always uses cursor-based SCAN, never KEYS, so a large keyspace
 *   never blocks the single-threaded Redis event loop.
 */

import { Redis } from "ioredis";
import { classifyCommand } from "./tools/commands.js";

let client: Redis | null = null;

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

function getRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url || url.trim() === "") {
    const hint =
      process.platform === "win32"
        ? " On Windows, env vars set in bash/WSL profiles are not visible to MCP servers launched via cmd." +
          ' Add "env": {"REDIS_URL": "redis://..."} to your .mcp.json.'
        : "";
    throw new Error(`REDIS_URL is not set. Provide a Redis connection string.${hint}`);
  }
  return url;
}

/**
 * Eagerly validate required configuration at startup. Calls getRedisUrl() purely
 * for its throw-on-missing behavior so the launcher can surface the missing-URL
 * error (and the Windows .mcp.json hint) in startup logs, instead of deferring it
 * to the first tool call. Only env validation runs here; the TCP connect stays
 * lazy inside getClient().
 */
export function validateConfig(): void {
  getRedisUrl();
}

export function getCommandTimeoutMs(): number {
  const raw = process.env.REDIS_COMMAND_TIMEOUT_MS;
  if (!raw) return 10_000;
  const parsed = Number(raw);
  // Floor to integer ms. ioredis accepts sub-ms values, but values below
  // network noise (e.g. 0.5ms) cause spurious command failures on a busy
  // event loop rather than meaningful timeouts. Timeouts are wall-clock-ish
  // at ms granularity; sub-ms precision isn't useful to callers.
  if (!Number.isFinite(parsed) || parsed <= 0) return 10_000;
  return Math.max(1, Math.floor(parsed));
}

export function getConnectTimeoutMs(): number {
  const raw = process.env.REDIS_CONNECT_TIMEOUT_MS;
  if (!raw) return 10_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 10_000;
  return Math.max(1, Math.floor(parsed));
}

export function getMaxKeys(): number {
  const raw = process.env.REDIS_MAX_KEYS;
  if (!raw) return 1000;
  const parsed = Number(raw);
  // Upper-clamp at 1_000_000: a fat-fingered REDIS_MAX_KEYS (e.g. 1e8) would
  // otherwise let a single scan tool call accumulate that many keys into memory
  // and the JSON reply. Mirrors the per-call schema caps (count <= 10000,
  // sampleSize <= 5000), which were already bounded -- only the env-derived
  // ceilings were open-ended. The lower bound is 1, checked BEFORE flooring:
  // a value in (0, 1) used to pass a `> 0` check and floor to 0. A cap of 0
  // sent `LRANGE`/`ZRANGE key 0 -1` from redis_get -- the whole list or zset,
  // with `truncated: false` -- and made every scan return no keys.
  if (!(Number.isFinite(parsed) && parsed >= 1)) return 1000;
  return Math.min(1_000_000, Math.floor(parsed));
}

export function getScanCount(): number {
  const raw = process.env.REDIS_SCAN_COUNT;
  if (!raw) return 100;
  const parsed = Number(raw);
  // Upper-clamp at 1_000_000 (an absolute sanity ceiling, far above any sane
  // COUNT hint): a pathological value would hold the single-threaded Redis
  // event loop for a long time per round-trip. The lower bound is 1, checked
  // BEFORE flooring: a value in (0, 1) used to floor to 0, and Redis rejects
  // `SCAN ... COUNT 0` with a syntax error, so every call that used this
  // value (redis_advisor, and redis_scan without its own `count`) failed.
  if (!(Number.isFinite(parsed) && parsed >= 1)) return 100;
  return Math.min(1_000_000, Math.floor(parsed));
}

/**
 * Max bytes of a string value `redis_get` will return before windowing it with
 * GETRANGE. A bare GET on a multi-megabyte string would dump the whole value
 * into the model context -- the exact failure `redis_key_info` warns about.
 * Default 256 KiB: large enough to return ordinary cache values whole, small
 * enough that a giant blob is truncated (with `truncated: true` + the full
 * `length`). Env-tunable via REDIS_MAX_VALUE_BYTES; clamped to a 64 MB ceiling.
 * The lower bound is 1, checked BEFORE flooring: a value in (0, 1) used to
 * floor to 0, and a cap of 0 sends `GETRANGE key 0 -1`, which Redis reads as
 * the whole string -- so the cap was off and `truncated` was wrongly true.
 */
export function getMaxValueBytes(): number {
  const raw = process.env.REDIS_MAX_VALUE_BYTES;
  if (!raw) return 262_144;
  const parsed = Number(raw);
  if (!(Number.isFinite(parsed) && parsed >= 1)) return 262_144;
  return Math.min(64_000_000, Math.floor(parsed));
}

export function isWritesAllowed(): boolean {
  const v = process.env.ALLOW_WRITES;
  return v === "1" || v === "true";
}

/** REDIS_TLS_REJECT_UNAUTHORIZED as a `tls` option, without warning about a typo. */
function parseTlsEnv(raw: string | undefined): { rejectUnauthorized: boolean } | undefined {
  if (raw === "0" || raw === "false") return { rejectUnauthorized: false };
  if (raw === "1" || raw === "true") return { rejectUnauthorized: true };
  return undefined;
}

export function getTlsConfig(): { rejectUnauthorized: boolean } | undefined {
  const raw = process.env.REDIS_TLS_REJECT_UNAUTHORIZED;
  if (raw === undefined) return undefined;
  const parsed = parseTlsEnv(raw);
  if (parsed) return parsed;
  // Env var IS set but doesn't match a recognized form (e.g. `Flase`, `yes`,
  // empty string). Returning undefined here would silently fall through to
  // ioredis's default behavior, which is indistinguishable from "env var
  // unset" and lets a typo connect with unintended TLS posture. Surface the
  // misconfiguration on stderr (stdio MCP uses stdout for protocol, so stderr
  // is safe for logs).
  console.error(
    `[redis-mcp] REDIS_TLS_REJECT_UNAUTHORIZED=${JSON.stringify(raw)} not recognized; expected "0", "false", "1", or "true". Deferring to the ioredis / connection-string default.`,
  );
  return undefined;
}

/**
 * The oldest oam whose TLS socket ioredis can use. Through 0.15.2 oam's
 * `tls.TLSSocket` lacked `setNoDelay`, `setKeepAlive`, `setTimeout` and
 * `connecting`, and never closed after the server hung up (YawLabs/oam#132), so
 * the first command over TLS threw an uncaught TypeError and killed the
 * process.
 *
 * The launcher (bin/redis-mcp.mjs) never serves on an oam below its OAM_MIN,
 * which is this same version -- a test keeps the two equal. But a host can run
 * dist/index.js directly under oam and skip the launcher entirely, so the
 * server checks for itself before it opens a TLS connection.
 */
export const OAM_TLS_MIN = [0, 15, 3] as const;

/**
 * Why this runtime cannot serve TLS, or null when it can. Null on Node, on an
 * oam at or above OAM_TLS_MIN, and on an oam version this cannot read: a
 * refusal there would block a build that may well work, while letting it
 * through risks no more than the crash this check exists to explain.
 */
export function tlsRuntimeProblem(oamVersion: string | undefined = process.versions.oam): string | null {
  if (oamVersion === undefined) return null;
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(oamVersion);
  if (!match) return null;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const [minMajor, minMinor, minPatch] = OAM_TLS_MIN;
  const atOrAbove = major !== minMajor ? major > minMajor : minor !== minMinor ? minor > minMinor : patch >= minPatch;
  if (atOrAbove) return null;
  return (
    `TLS (rediss://) needs oam ${OAM_TLS_MIN.join(".")} or newer, and this server is running on oam ${oamVersion}, ` +
    "whose TLS socket crashes the Redis client (YawLabs/oam#132). Update oam (https://oamjs.org), " +
    "or run the server on Node -- the redis-mcp launcher does that for you."
  );
}

/**
 * Whether the client getClient() builds will use TLS: a `rediss://` URL, a
 * `tls` query parameter (ioredis reads `?tls=true` and its named profiles
 * such as `?tls=RedisCloudFixed`), or the `tls` option this server passes
 * whenever REDIS_TLS_REJECT_UNAUTHORIZED holds a recognized value. Answered by
 * ioredis itself, from a throwaway client that never connects, so it cannot
 * drift from what getClient() decides. False when REDIS_URL is unset or
 * unparseable -- the server reports those on its own. For the startup warning.
 */
export function wouldUseTls(): boolean {
  const url = process.env.REDIS_URL;
  if (!url || url.trim() === "") return false;
  const tls = parseTlsEnv(process.env.REDIS_TLS_REJECT_UNAUTHORIZED);
  let probe: Redis;
  try {
    probe = new Redis(url, { lazyConnect: true, ...(tls ? { tls } : {}) });
  } catch {
    return false;
  }
  const uses = Boolean(probe.options.tls);
  probe.disconnect();
  return uses;
}

/**
 * Returns the singleton client, creating it on first call.
 *
 * Env-var snapshot semantics: every connection option below is read ONCE, when
 * the client is constructed. Changing `REDIS_URL`, `REDIS_COMMAND_TIMEOUT_MS`,
 * `REDIS_CONNECT_TIMEOUT_MS`, or `REDIS_TLS_REJECT_UNAUTHORIZED` after the first
 * tool call has no effect until `shutdown()` runs and a subsequent call rebuilds
 * the client. The values that ARE re-read per request live on `getMaxKeys()`,
 * `getScanCount()`, and `isWritesAllowed()`, which are invoked inside the
 * request path.
 */
export function getClient(): Redis {
  if (client) return client;
  const tls = getTlsConfig();
  const url = getRedisUrl();
  // ioredis accepts a connection URL plus an options object. `lazyConnect`
  // keeps construction synchronous and defers the TCP connect to the first
  // command, so a bad host surfaces on the first tool call (where we can
  // return a clean error) rather than throwing during module init.
  //
  // maxRetriesPerRequest=0 means a failed command rejects immediately instead
  // of being queued and silently retried -- an MCP tool call should fail fast
  // with a readable error, not hang while ioredis retries in the background.
  const created = new Redis(url, {
    lazyConnect: true,
    connectTimeout: getConnectTimeoutMs(),
    commandTimeout: getCommandTimeoutMs(),
    maxRetriesPerRequest: 0,
    // Allow up to 3 reconnect attempts on a dropped connection with growing
    // backoff (200ms, 400ms, 800ms). After that, surface the failure rather
    // than reconnect-looping forever. The MCP server process is long-lived,
    // so a few transient blips (a brief TCP RST during a host deploy, a
    // 200ms wifi drop) should not require a full process restart. Three is
    // chosen as the budget: enough to absorb a typical deploy blip, low
    // enough that a genuinely dead host fails within ~1.4s of total wait.
    retryStrategy: (times) => (times > 3 ? null : 200 * 2 ** (times - 1)),
    ...(tls ? { tls: { rejectUnauthorized: tls.rejectUnauthorized } } : {}),
  });
  // Refuse TLS on an oam that cannot carry it, before anything is dialled
  // (lazyConnect), as an error the tool call returns rather than a crash. The
  // client is not cached, so an updated runtime is picked up on restart.
  const problem = created.options.tls ? tlsRuntimeProblem() : null;
  if (problem) {
    created.disconnect();
    throw new Error(problem);
  }
  client = created;
  // ioredis emits 'error' for connection-level failures. Log to stderr so the
  // stdio MCP protocol channel (stdout) stays clean. Without a listener,
  // ioredis throws unhandled 'error' events that can crash the process.
  client.on("error", (err: Error) => {
    console.error(`[redis-mcp] client error: ${err.message}`);
  });
  return client;
}

export function formatRedisError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  // ioredis surfaces server-side errors with a `message` like
  // "READONLY You can't write against a read only replica." or
  // "NOAUTH Authentication required." The message itself carries the
  // Redis error-code prefix an agent can act on. We also surface the error
  // CLASS (err.name) when it differs from the generic "Error" so an agent
  // can distinguish "Connection is closed" (ConnectionError) from
  // "WRONGTYPE Operation against a key holding the wrong kind of value"
  // (ReplyError) without parsing the message. Built-in Error subclasses
  // like TypeError / RangeError are passed through as-is -- their `name`
  // is more specific than "Error" and is useful to surface.
  if (err.name && err.name !== "Error") {
    return `${err.name}: ${err.message}`;
  }
  return err.message;
}

/**
 * Run a single Redis command, honoring the ALLOW_WRITES gate. Read-only
 * commands always pass; mutating commands require ALLOW_WRITES=1. Unknown /
 * arbitrary-execution commands are rejected (fail-closed) so a typo or a
 * dangerous command can't slip through. `subcommand` (the first arg) is
 * forwarded so multi-word commands like `CONFIG SET` are gated as writes.
 */
export async function runCommand<T = unknown>(
  command: string,
  args: (string | number)[],
  subcommand?: string,
): Promise<ApiResponse<T>> {
  const decision = classifyCommand(command, isWritesAllowed(), subcommand);
  if (!decision.allowed) {
    return { ok: false, error: decision.reason };
  }
  try {
    const c = getClient();
    const result = (await c.call(command, ...args.map(String))) as T;
    return { ok: true, data: result };
  } catch (err) {
    return { ok: false, error: formatRedisError(err) };
  }
}

export async function shutdown(): Promise<void> {
  if (!client) return;
  // client.quit() sends QUIT and waits for the server to close the socket. If
  // the connection is already broken, that can hang; cap the wait and fall back
  // to disconnect() (synchronous local socket teardown) so cleanup is bounded
  // and the signal handler can still call process.exit().
  const ending = client;
  client = null;
  try {
    await Promise.race([
      ending.quit(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("redis shutdown timed out after 5s")), 5_000),
      ),
    ]);
  } catch {
    // Best-effort: force the socket closed. If even this throws, the underlying
    // TCP socket gets reaped when the process exits.
    try {
      ending.disconnect();
    } catch {
      // ignore
    }
  }
}
