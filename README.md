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

All env vars are read from the MCP server's environment. The last three are read by the `redis-mcp` launcher rather than the server, so they have no effect when a host runs `dist/index.js` directly:

| Variable | Default | Purpose |
|----------|---------|---------|
| `REDIS_URL` | (required) | Redis connection string, e.g. `redis://:pass@host:6379/0` or `rediss://...` for TLS. |
| `ALLOW_WRITES` | unset | Set to `1` or `true` to permit curated mutating commands via `redis_command`. Arbitrary-execution commands stay blocked regardless. |
| `REDIS_COMMAND_TIMEOUT_MS` | `10000` | Per-command timeout. A command that runs longer is aborted so a wedged call can't hang the agent. |
| `REDIS_CONNECT_TIMEOUT_MS` | `10000` | TCP connect timeout. Without this, a dead host hangs until the OS gives up (~2 minutes). |
| `REDIS_MAX_KEYS` | `1000` | Cap on keys returned by a single scan, and on collection elements returned by `redis_get`. Clamped to `1000000`; a fraction is rounded down, and a value below `1` or a non-numeric one falls back to the default. |
| `REDIS_MAX_VALUE_BYTES` | `262144` | Cap, in bytes, on a string value returned by `redis_get` (256 KiB). A longer string comes back as its first `REDIS_MAX_VALUE_BYTES` bytes, with `truncated: true` and its full `length`. Clamped to `64000000` (64 MB); a fraction is rounded down, and a value below `1` or a non-numeric one falls back to the default. |
| `REDIS_SCAN_COUNT` | `100` | `COUNT` hint per `SCAN` iteration. Higher = fewer round-trips but more work per iteration. Clamped to `1000000`; a fraction is rounded down, and a value below `1` or a non-numeric one falls back to the default. |
| `REDIS_TLS_REJECT_UNAUTHORIZED` | unset | Set to `false` to skip TLS cert verification (for managed Redis using private-CA certs). Connection is still encrypted. |
| `REDIS_MCP_RUNTIME` | `auto` | Which JS runtime executes the server: `auto` (the newest [oam](https://oamjs.org) it can find at 0.15.2 or newer, else Node), `oam` (the same, but exit with an error instead of falling back), `node` (always Node - in-process under `npx`, handed off to Node on `PATH` when a client launches the command with `oam run`). Case-insensitive; any other value - a typo like `nodejs`, or one with surrounding spaces - behaves as `auto` without a warning. See [Runtime](#runtime). |
| `OAM_BIN` | unset | Path to an `oam` binary to use in preference to discovery, when it is 0.15.2 or newer. If it does not exist, is older, or will not run, the launcher says so on stderr and carries on with discovery. Ignored under `REDIS_MCP_RUNTIME=node`, and when the launcher is already running under oam 0.15.2+ unless `REDIS_MCP_SANDBOX=1`. |
| `REDIS_MCP_SANDBOX` | unset | Exactly `1` runs the server under oam's `--permission` sandbox: filesystem and child processes denied, network limited to the host and port in `REDIS_URL` (port `6379` if the URL names none). An IPv6 literal (`redis://[::1]:6379`) is pinned like any other host. The host and port are read the way ioredis reads them, so a scheme-less `REDIS_URL` (`127.0.0.1:6379`), a bare port number, a `host` or `port` in the query string, and a URL with no host (`localhost`) are pinned too. If `REDIS_URL` cannot be pinned - a unix socket path, a URL that does not parse, a port that is not one - the network grant is left open, and the launcher says so on stderr. A `REDIS_MCP_SANDBOX` value other than `1` is ignored without a warning. It has no effect unless a fresh oam is actually spawned, and a fallback does not always mention it, so pair it with `REDIS_MCP_RUNTIME=oam`, which exits instead of falling back. The launcher only spawns oam 0.15.2 or newer, which has both fixes the sandbox depends on: per oam's changelog, `--permission` did not cover all of `fs` and `child_process` until 0.9.1, and the port grant was not exact until 0.15.0. |

### Connecting to managed Redis (Upstash, ElastiCache, Redis Cloud, etc.)

Use a `rediss://` URL for TLS. If the provider serves a cert signed by a private CA that Node's trust store doesn't recognize (symptoms: `self signed certificate in certificate chain`, `unable to verify the first certificate`), add `REDIS_TLS_REJECT_UNAUTHORIZED=false`:

```json
"env": {
  "REDIS_URL": "rediss://default:pass@host:6379",
  "REDIS_TLS_REJECT_UNAUTHORIZED": "false"
}
```

This disables certificate-chain verification only - the connection is still TLS-encrypted end-to-end. Where you can install the CA, prefer `NODE_EXTRA_CA_CERTS` over disabling verification - but only Node reads that variable ([YawLabs/oam#136](https://github.com/YawLabs/oam/issues/136)). Under oam (see [Runtime](#runtime)) a private CA needs either `REDIS_TLS_REJECT_UNAUTHORIZED=false` or `REDIS_MCP_RUNTIME=node`.

### Runtime

The published `redis-mcp` command is a small launcher that prefers the newest [oam](https://oamjs.org) JavaScript runtime it can find and falls back to Node. It only uses the latest oam release, currently **0.15.2**, and never serves on an older one. **If you do not have oam, nothing changes:** the fallback is automatic, and because npm has already started Node to run the launcher, it is an in-process `import()` of the server with no extra spawn.

**TLS under oam.** Through oam 0.15.2, oam's TLS socket lacks some of the `net.Socket` methods ioredis calls ([YawLabs/oam#132](https://github.com/YawLabs/oam/issues/132)) and does not close itself when the server hangs up. The server supplies both itself, so `rediss://` works on either runtime, sandbox included, and a dropped idle connection is reconnected. The first time that happens the server says so on stderr (`using in-process shims`); on an oam that has these members (fixed on oam's main branch by [YawLabs/oam#141](https://github.com/YawLabs/oam/pull/141)) nothing is shimmed and nothing is printed. What oam does not have is `NODE_EXTRA_CA_CERTS` ([YawLabs/oam#136](https://github.com/YawLabs/oam/issues/136)): for a private CA under oam, use `REDIS_TLS_REJECT_UNAUTHORIZED=false` or `REDIS_MCP_RUNTIME=node`.

**How the runtime is chosen:**

- **Already on oam.** If the launcher itself is running under oam 0.15.2+ (a host that runs `oam run` on the `bin`), the server is imported into that process: nothing is discovered or spawned, `OAM_BIN` is ignored, and `REDIS_MCP_RUNTIME=oam` is satisfied. `REDIS_MCP_SANDBOX=1` skips this step, because only a freshly spawned oam can apply `--permission`.
- **Otherwise, discovery.** The launcher uses `OAM_BIN` if it is 0.15.2 or newer. Otherwise it asks every oam it can find - the default install locations (`%LOCALAPPDATA%\oam\bin` then `~/.oam/bin` on Windows, `~/.oam/bin` elsewhere), then `PATH` - for its version, and spawns the newest one at 0.15.2 or newer; on a tie the installed copy wins. On Windows only `oam.exe` counts. An `OAM_BIN` that does not exist, is older, or will not run is named on stderr and discovery carries on.
- **No usable oam.** Under `auto` the server runs in the launcher's own process instead (an old oam host hands off, see below). The launcher says so on stderr when it passed over an `OAM_BIN`, a found oam that was too old or would not run, or (on Windows) an `oam.cmd` / `oam.bat` on `PATH`, or when the chosen oam failed to launch. With no oam found at all it falls back silently; only the handoff from an old oam host is always noted. Once oam has started, a failure while running the server is a startup failure, not a fallback.
- **An old oam host never serves.** If the launcher is running under an oam older than 0.15.2, it hands the server off to the newest usable oam, else to Node on `PATH`, and exits with an error when there is neither.
- **Overrides.** `REDIS_MCP_RUNTIME=oam` turns every fallback into a startup failure. `REDIS_MCP_RUNTIME=node` skips discovery and always runs Node: in the launcher's own process under Node, handed off to Node on `PATH` under oam.

No fallback carries `--permission` - not in-process, and not a handoff to Node - so with `REDIS_MCP_SANDBOX=1` under `auto` the server can end up **unsandboxed**. Only a fallback on an oam 0.15.2+ host says so (`without --permission`), and only when it has something else to report; otherwise there is no message, or one that does not mention the sandbox. Set `REDIS_MCP_RUNTIME=oam` alongside it when that is not acceptable.

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

[![Follow @TokenLimitNews on X](https://img.shields.io/badge/follow-%40TokenLimitNews-000000?logo=x&logoColor=white)](https://x.com/TokenLimitNews)
