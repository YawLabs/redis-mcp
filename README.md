# @yawlabs/redis-mcp

[![npm version](https://img.shields.io/npm/v/@yawlabs/redis-mcp)](https://www.npmjs.com/package/@yawlabs/redis-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

**Explore and diagnose a Redis instance from Claude Code, Cursor, and any MCP client.** Read-only by default - writes opt in via a single env var - and key enumeration always uses `SCAN`, never the O(N) `KEYS`, so it is safe to point at a production instance with millions of keys.

Built and maintained by [Yaw Labs](https://yaw.sh).

[![Add to Yaw MCP](https://yaw.sh/yaw-mcp-button.svg)](https://yaw.sh/mcp/install?name=Redis&command=npx&args=-y%2C%40yawlabs%2Fredis-mcp&description=Explore%20and%20diagnose%20Redis%20-%20SCAN%20key%20exploration%2C%20health%2C%20DBA%20advisor&source=https%3A%2F%2Fgithub.com%2FYawLabs%2Fredis-mcp)

One click adds this to your local Yaw MCP config so it's available in every Yaw Terminal session. Or install manually below.

## Why this one?

- **`SCAN`, never `KEYS`.** Every key-enumeration path uses cursor-based `SCAN` with a bounded `COUNT` and an iteration cap. `KEYS *` is O(N) over the entire keyspace and blocks Redis's single-threaded event loop for the full scan - a self-inflicted outage on a large instance. `SCAN` yields between batches. See [Security](#security).
- **Read-first command gate.** Tools run a curated read-only command allowlist by default. Mutating commands (`SET`, `DEL`, `EXPIRE`, `HSET`, ...) require `ALLOW_WRITES=1`. Arbitrary-execution commands (`EVAL`, `FUNCTION`, `SCRIPT`, `MULTI`, `MONITOR`, `SHUTDOWN`, `CLUSTER`, ...) are never exposed, even with writes on - the gate is a curated allowlist, not "anything when writes are enabled".
- **Type-aware reads without surprises.** `redis_get` dispatches by value type (string / hash / list / set / zset / stream) and windows collection reads to a cap, so a million-element list can't blow out the model context. `redis_key_info` reads type / TTL / encoding / memory footprint without pulling the value at all.
- **Health in one call.** `redis_health` rolls up `INFO` + `DBSIZE` + recent `SLOWLOG` into memory pressure, eviction policy, hit rate, ops/sec, persistence status, replication role, per-database key counts (and how many lack a TTL), and the most recent slow commands.
- **A real advisor.** `redis_advisor` is the "what should I be looking at?" lint pass: big keys, missing TTLs, eviction pressure (including the dangerous `noeviction` + no-TTL combination), and fork-latency risk - each with a severity and an actionable fix. Keys are SCAN-sampled, so it is safe on a large instance.
- **Instant startup.** Ships as a single bundled file with zero runtime dependencies. No multi-minute `node_modules` install on every `npx` cold start.

## Scope

This server is a **read-first explorer and diagnostician**, not a general Redis admin console. It deliberately does not expose `EVAL`/`FUNCTION`/`SCRIPT`, pub/sub, `MONITOR`, cluster management, or replication control. For those, use `redis-cli` directly. The goal here is the safe, common 90%: "what's in this instance, is it healthy, and what should I worry about?" - the questions an agent should be able to answer against a production Redis without risk.

Works against Redis 6+ and Valkey. A few `redis_health` fields (`latest_fork_usec`, `aof_enabled`) depend on the running server exposing them in `INFO`; missing fields surface as `null` rather than erroring.

## Quick start

**1. Create `.mcp.json` in your project root**

macOS / Linux / WSL:

```json
{
  "mcpServers": {
    "redis": {
      "command": "npx",
      "args": ["-y", "@yawlabs/redis-mcp@latest"],
      "env": {
        "REDIS_URL": "redis://:password@host:6379/0"
      }
    }
  }
}
```

Windows:

```json
{
  "mcpServers": {
    "redis": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@yawlabs/redis-mcp@latest"],
      "env": {
        "REDIS_URL": "redis://:password@host:6379/0"
      }
    }
  }
}
```

> **Why the extra step on Windows?** Since Node 20, `child_process.spawn` cannot directly execute `.cmd` files (that's what `npx` is on Windows). Wrapping with `cmd /c` is the standard workaround.

**2. Restart and approve**

Restart Claude Code (or your MCP client) and approve the redis MCP server when prompted.

**3. (Optional) Enable writes**

Read-only is the default. To let the agent run mutating commands (`SET`, `DEL`, `EXPIRE`, `HSET`, ...) via `redis_command`, add `ALLOW_WRITES=1`:

```json
"env": {
  "REDIS_URL": "redis://...",
  "ALLOW_WRITES": "1"
}
```

Prefer scoping this to dev/test instances. Even with writes on, arbitrary-execution commands stay blocked.

## Security

**`SCAN`, not `KEYS` - this is the load-bearing choice.** Redis is single-threaded. `KEYS pattern` walks the entire keyspace in one uninterruptible operation; on an instance with millions of keys it blocks every other client for the duration - effectively a denial of service you triggered yourself. Every key-enumeration path in this server (`redis_scan`, the advisor's key sampling, `redis_get`'s set reads) uses cursor-based `SCAN`/`SSCAN` with a bounded `COUNT` and a hard iteration cap, which yields the event loop between batches. `KEYS` is explicitly rejected by the command gate with a nudge to `redis_scan`.

**Read-only by default.** Without `ALLOW_WRITES=1`, only commands on the read-only allowlist run; everything else is rejected before it reaches Redis. With `ALLOW_WRITES=1`, a curated set of mutating commands is additionally permitted - but arbitrary-execution commands (`EVAL`, `FUNCTION`, `SCRIPT`, `MULTI`/`EXEC`, `MONITOR`, `SHUTDOWN`, `REPLICAOF`, `CLUSTER`, `MIGRATE`, ...) remain blocked in all modes. The gate is fail-closed: a command on neither allowlist is rejected, so a command we never anticipated can't slip through.

**Use Redis ACLs as the primary control.** As with a database role, the cleanest posture is a least-privileged Redis user (`ACL SETUSER mcp on >pass ~* +@read`) in `REDIS_URL`. Redis then enforces the boundary server-side, independent of this server's gate. `ALLOW_WRITES` is defense-in-depth on top of that.

See [SECURITY.md](./SECURITY.md) for vulnerability reporting.

## Tools

| Tool | Description |
|------|-------------|
| `redis_scan` | Enumerate keys with cursor-based `SCAN` (never `KEYS`). Optional glob `match`, value-`type` filter, and resumable `cursor`. Capped at `REDIS_MAX_KEYS`. |
| `redis_key_info` | Inspect one key without reading its value: type, TTL (s/ms), encoding, memory footprint, idle time. The big-key / missing-TTL probe. |
| `redis_get` | Read a key's value, dispatching by type (string / hash / list / set / zset / stream). Collection reads windowed by `limit`. Always read-only. |
| `redis_command` | Run a single Redis command through the safety gate. Reads always run; writes need `ALLOW_WRITES=1`; `KEYS` and arbitrary-execution commands are blocked. The escape hatch for commands without a dedicated tool. |
| `redis_health` | One-call health snapshot from `INFO` + `DBSIZE` + `SLOWLOG`: memory pressure, eviction policy, hit rate, ops/sec, persistence, replication role, per-db key counts, recent slow commands. |
| `redis_slowlog` | Recent entries from the Redis slow log - command, microseconds, timestamp, client. Read-only (`SLOWLOG GET`). |
| `redis_advisor` | Rolled-up health lints in one call: big keys, missing TTLs, eviction pressure, fork-latency risk. Each finding has a severity and a fix. SCAN-sampled, safe on large instances. |

## Configuration

All env vars are read from the MCP server's environment:

| Variable | Default | Purpose |
|----------|---------|---------|
| `REDIS_URL` | (required) | Redis connection string, e.g. `redis://:pass@host:6379/0` or `rediss://...` for TLS. |
| `ALLOW_WRITES` | unset | Set to `1` or `true` to permit curated mutating commands via `redis_command`. Arbitrary-execution commands stay blocked regardless. |
| `REDIS_COMMAND_TIMEOUT_MS` | `10000` | Per-command timeout. A command that runs longer is aborted so a wedged call can't hang the agent. |
| `REDIS_CONNECT_TIMEOUT_MS` | `10000` | TCP connect timeout. Without this, a dead host hangs until the OS gives up (~2 minutes). |
| `REDIS_MAX_KEYS` | `1000` | Cap on keys returned by a single scan, and on collection elements returned by `redis_get`. |
| `REDIS_SCAN_COUNT` | `100` | `COUNT` hint per `SCAN` iteration. Higher = fewer round-trips but more work per iteration. |
| `REDIS_TLS_REJECT_UNAUTHORIZED` | unset | Set to `false` to skip TLS cert verification (for managed Redis using private-CA certs). Connection is still encrypted. |

### Connecting to managed Redis (Upstash, ElastiCache, Redis Cloud, etc.)

Use a `rediss://` URL for TLS. If the provider serves a cert signed by a private CA that Node's trust store doesn't recognize (symptoms: `self signed certificate in certificate chain`, `unable to verify the first certificate`), add `REDIS_TLS_REJECT_UNAUTHORIZED=false`:

```json
"env": {
  "REDIS_URL": "rediss://default:pass@host:6379",
  "REDIS_TLS_REJECT_UNAUTHORIZED": "false"
}
```

This disables certificate-chain verification only - the connection is still TLS-encrypted end-to-end. Where you can install the CA, prefer `NODE_EXTRA_CA_CERTS` over disabling verification.

## Troubleshooting

**`REDIS_URL is not set`** - Your MCP client is launching the server without the env var. On Windows especially, env vars set in bash / PowerShell profiles are not inherited by MCP servers launched via `cmd`. Put `REDIS_URL` directly in the `env` block of `.mcp.json`.

**`NOAUTH Authentication required`** - The instance requires a password and the URL has none. Add it: `redis://:yourpassword@host:6379` (note the leading colon - the username is empty for the default user).

**`<COMMAND> mutates state and is blocked: ALLOW_WRITES is not set`** - You asked for a write through `redis_command` in read-only mode. Add `ALLOW_WRITES=1` to the `env` block (dev/test), or - cleaner - use a Redis ACL user scoped to the access you want.

**`KEYS is blocked`** - Intentional. Use `redis_scan` (cursor-based) to enumerate keys; it is safe on a large keyspace where `KEYS` is not.

**First command is slow, subsequent commands are fast** - Expected. The client connects lazily on the first command; later commands reuse the connection.

## Development

```bash
npm install
npm test          # build + unit tests (no live Redis needed)
```

The unit suite covers the pure logic - command allowlist enforcement, SCAN cursor paging, INFO/SLOWLOG parsing, and the advisor heuristics - and runs without a Redis instance. Integration tests that exercise live paths (`npm run test:integration`) require a disposable Redis at `REDIS_URL`.

## License

MIT © 2026 YawLabs
