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
 *   - REDIS_MAX_KEYS                   - max keys returned by a single scan tool call
 *                                        (default: 1000). Caps both the response size
 *                                        and the number of SCAN iterations.
 *   - REDIS_SCAN_COUNT                 - COUNT hint per SCAN iteration (default: 100).
 *                                        A larger value scans more keys per round-trip
 *                                        but holds the Redis event loop slightly longer
 *                                        each iteration.
 *   - REDIS_TLS_REJECT_UNAUTHORIZED    - "false" to disable TLS cert verification (for
 *                                        managed Redis using private-CA certs). The
 *                                        connection is still encrypted.
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

export function getCommandTimeoutMs(): number {
  const raw = process.env.REDIS_COMMAND_TIMEOUT_MS;
  if (!raw) return 10_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10_000;
}

export function getConnectTimeoutMs(): number {
  const raw = process.env.REDIS_CONNECT_TIMEOUT_MS;
  if (!raw) return 10_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10_000;
}

export function getMaxKeys(): number {
  const raw = process.env.REDIS_MAX_KEYS;
  if (!raw) return 1000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1000;
}

export function getScanCount(): number {
  const raw = process.env.REDIS_SCAN_COUNT;
  if (!raw) return 100;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 100;
}

export function isWritesAllowed(): boolean {
  const v = process.env.ALLOW_WRITES;
  return v === "1" || v === "true";
}

export function getTlsConfig(): { rejectUnauthorized: boolean } | undefined {
  const raw = process.env.REDIS_TLS_REJECT_UNAUTHORIZED;
  if (raw === undefined) return undefined;
  if (raw === "0" || raw === "false") return { rejectUnauthorized: false };
  if (raw === "1" || raw === "true") return { rejectUnauthorized: true };
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
  client = new Redis(url, {
    lazyConnect: true,
    connectTimeout: getConnectTimeoutMs(),
    commandTimeout: getCommandTimeoutMs(),
    maxRetriesPerRequest: 0,
    // Allow one reconnection attempt on a dropped connection; beyond that,
    // surface the failure rather than reconnect-looping forever.
    retryStrategy: (times) => (times > 1 ? null : 200),
    ...(tls ? { tls: { rejectUnauthorized: tls.rejectUnauthorized } } : {}),
  });
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
  // "NOAUTH Authentication required." Pass the message through; it already
  // carries the Redis error-code prefix an agent can act on.
  return err.message;
}

/**
 * Run a single read-only Redis command via the allowlist gate. The command name
 * is checked against the read-only allowlist (commands.ts) with writes
 * disallowed regardless of `ALLOW_WRITES`; this path is for internal tool code
 * that should NEVER mutate (health rollups, the advisor). `subcommand` (the
 * first arg) is forwarded so multi-word commands like `CONFIG GET` classify
 * correctly.
 */
export async function runReadOnlyCommand<T = unknown>(
  command: string,
  args: (string | number)[],
  subcommand?: string,
): Promise<ApiResponse<T>> {
  const decision = classifyCommand(command, /* writesAllowed */ false, subcommand);
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
