# Changelog

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
