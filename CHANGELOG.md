# Changelog

## [Unreleased]

### Fixed
- **A launcher already running on oam no longer spawns a second, nested oam.** A host that resolves the `bin` and launches `oam run bin/redis-mcp.mjs` — Yaw MCP does — got one server for the price of two runtime boots, because the launcher discovered and spawned an oam without checking what it was already running on (measured on Windows as `oam.exe` with a nested `oam.exe` + `conhost.exe` underneath). When `process.versions.oam` clears the same 0.9.0 floor a discovered binary must, the server is now imported into the running process. `REDIS_MCP_SANDBOX=1` keeps the discovery path, because `--permission` and the `REDIS_URL`-pinned net grant only apply to a fresh oam — but discovery is not a guaranteed spawn: if it finds no usable oam, `REDIS_MCP_RUNTIME=auto` still falls back in-process *without* `--permission`. Set `REDIS_MCP_RUNTIME=oam` alongside it to make that a hard exit.
- **The launcher no longer dies with a raw stack trace when `spawn` fails.** Node throws synchronously rather than emitting `error` for some unexecutable targets — notably a `.cmd`/`.bat` on Windows — and the `error` listener is registered *after* the `spawn` call, so it could never observe that throw. Both failure modes now route through one handler.
- **Windows `PATH` discovery accepts `oam.exe` only**, instead of walking every `PATHEXT` entry and returning an `oam.cmd` Node cannot execute. A skipped shim is still **named** in the diagnostic, so an npm-style install no longer reports as "no oam binary was found".
- **A failing in-process fallback no longer escapes as an unhandled rejection.** `void runInProcess()` discarded the promise, replacing the launcher's own diagnostic with a raw stack trace.
- **Diagnostics that precede `process.exit` are written synchronously.** stderr is async for TTYs and pipes on Windows, so the exit could truncate them. They route through one helper that also handles short writes and macOS `EAGAIN` on a non-blocking piped stderr.
- Removed a literal backspace byte (`U+0008`) from the runtime-discovery comment, which made git treat the file as binary so its diff could not be reviewed.
- **An oam that cannot be *run* is no longer reported as an *outdated* one.** The version probe returns null for several distinct causes — not executable, wrong architecture, a shim Node refuses, deleted since the stat, unparseable `--version` output — and every one produced "older than oam 0.9.0 … run `oam self-update`", pointing at the single cause it definitely was not. The two cases now carry separate wording and remedies, and the outdated message reports the version actually detected.
- **Windows: the launcher no longer hard-kills the server on the first Ctrl-C.** There are no POSIX signals on Windows — `child.kill(sig)` ignores the name and calls `TerminateProcess`, an immediate hard kill (verified: a child with a `SIGTERM` handler never runs it and dies with `code=null`). The launcher forwarded anyway, on the stated assumption that this was a "no-op on Windows", so it aborted the graceful shutdown the console's own Ctrl-C had just started and skipped the server's `process.on("exit")` cleanup. The console already delivers the event to the whole process group, so on Windows the launcher now forwards nothing.
- **A wedged server no longer leaves the launcher hanging.** Forwarding was gated on `child.killed`, which records only that `kill()` was *called* — never that the child is gone — so every signal after the first was swallowed and there was no escape hatch. Escalation is now armed by a timer on the first signal: one press is enough, and a child still alive after a 2s grace window is killed. Using a timer rather than counting signals also stops the ordinary supervisor sequence (`SIGINT` then `SIGTERM` milliseconds apart) from being misread as impatience.

## [0.2.0] — 2026-08-07

### Added
- Runtime launcher at `bin/redis-mcp.mjs`: the published `redis-mcp` command now prefers the [oam](https://oamjs.org) runtime and falls back to Node. `REDIS_MCP_RUNTIME` selects (`auto` / `oam` / `node`) and `OAM_BIN` overrides discovery. Both paths verified against the MCP surface — handshake plus all 7 tools — and behave identically. The fallback does **not** re-exec Node: npm has already started Node to run the launcher, so it is an in-process `import()` with no extra spawn.

### Changed
- `.gitignore` excludes `bin/*` rather than `bin/`, so the launcher can be re-included with a negation. A negation cannot undo a directory-level exclusion — that trap shipped a broken `bin` in postgres-mcp, where the launcher was untracked and absent from every fresh clone.
- `scripts/build-binary.mjs` pins the CLI source entry instead of deriving it from `bin`'s value, which would have resolved to `bin/redis-mcp.ts` once `bin` moved to the launcher — the breakage postgres-mcp shipped in its 0.9.0.

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - Unreleased

### Added

- `redis_advisor` thresholds (`usedPctWarn`, `forkUsecWarn`, `largeDatasetBytes`)
  are now tunable tool inputs (defaults unchanged). Keys missing a TTL are also
  inferred from the per-database `INFO` keyspace section, not just the sample.
- `redis_health` validates `DBSIZE` as a finite number; non-numeric results
  surface as `null` instead of `NaN`.
- Eager `validateConfig()` at startup: a missing `REDIS_URL` (with the Windows
  `.mcp.json` hint) is now logged and exits before the stdio transport starts.
- `redis_scan` response includes `maxIterations` and a more specific `_note`
  when the iteration cap trips (vs. the key cap).
- `redis_get` collection reads are now bounded: hash uses `HSCAN` and set uses
  `SSCAN` (never materializing a million-field hash in one shot), and all
  collection types report `truncated: total > returned`.

### Changed

- `redis_advisor` now routes its key-sampling SCAN through the shared
  `accumulateScan` loop (same as `redis_scan`); the response surfaces
  `scan_truncated`, `scan_iterations`, `scan_max_iterations`, and a
  `probe_failures` count so an agent can detect when probes errored wholesale
  (e.g. ACL blocking `MEMORY USAGE`) instead of trusting a `0% TTL` finding.
- Big-key findings sort by severity first, then memory/element count --
  critical findings no longer sink below a smaller key.
- `classifyCommand` for multi-word commands with no subcommand returns
  `kind: "incomplete"` (was `"unknown"`), making "verb is known, just give me
  a subcommand" distinguishable from "verb is rejected outright".
- `WAIT` removed from the read-only allowlist (it's a write side-effect).
- `retryStrategy` allows up to 3 reconnects with growing backoff (200/400/800ms)
  instead of 1 -- absorbs brief deploy blips without a process restart.
- `getCommandTimeoutMs` / `getConnectTimeoutMs` floor to integer ms;
  sub-ms values were below network noise and produced spurious timeouts.
- `formatRedisError` prefixes non-generic `err.name` (`ReplyError:`,
  `ConnectionError:`) so an agent can triage error class without parsing the
  message.
- Release script: `lint:fix` runs before `lint` on the plain (non-CI) path,
  matching the pre-commit checklist.

### Notes

- Env-var snapshot semantics: `REDIS_URL`, `REDIS_COMMAND_TIMEOUT_MS`,
  `REDIS_CONNECT_TIMEOUT_MS`, and `REDIS_TLS_REJECT_UNAUTHORIZED` are read
  ONCE at first tool call. Changing them at runtime (e.g. via `.mcp.json`)
  has no effect until the process restarts. `REDIS_MAX_KEYS`,
  `REDIS_SCAN_COUNT`, and `ALLOW_WRITES` are re-read per request and
  take effect immediately.

## [0.1.0] - Unreleased

Initial scaffold.

### Added

- Read-first Redis MCP server modeled on `@yawlabs/postgres-mcp`.
- Command safety gate (`classifyCommand`): a curated read-only allowlist that
  always runs, a curated write allowlist gated behind `ALLOW_WRITES=1`, and
  fail-closed rejection of everything else (including `EVAL`/`FUNCTION`/`SCRIPT`/
  `MULTI`/`MONITOR`/`SHUTDOWN`/`CLUSTER`, which stay blocked even with writes on).
  `KEYS` is explicitly rejected with a `SCAN` nudge.
- Tools:
  - `redis_scan` - cursor-based `SCAN` key enumeration (never `KEYS`), with
    glob `match`, value-`type` filter, resumable `cursor`, and a `REDIS_MAX_KEYS`
    cap plus an iteration cap.
  - `redis_key_info` - per-key type / TTL / encoding / memory footprint / idle
    time without reading the value.
  - `redis_get` - type-aware value read (string/hash/list/set/zset/stream),
    collection reads windowed by `limit`.
  - `redis_command` - gated single-command escape hatch.
  - `redis_health` - `INFO` + `DBSIZE` + `SLOWLOG` rollup.
  - `redis_slowlog` - recent slow commands.
  - `redis_advisor` - big keys, missing TTLs, eviction pressure, and
    fork-latency risk, each with severity + fix; keys SCAN-sampled.
- Unit tests for the pure logic: command allowlist enforcement, SCAN cursor
  paging, INFO/keyspace/SLOWLOG parsing, advisor heuristics, env-var config, and
  schema guards. No live Redis required.
- Single-file esbuild bundle for instant `npx` cold starts.
