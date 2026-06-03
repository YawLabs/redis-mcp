# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
