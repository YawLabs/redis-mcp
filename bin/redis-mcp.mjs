#!/usr/bin/env node
/**
 * Runtime launcher for @yawlabs/redis-mcp.
 *
 * Prefers the newest usable oam runtime (https://oamjs.org) and falls back to
 * Node. It never serves on an oam older than the floor below.
 *
 *
 * WHY THE FALLBACK COSTS NOTHING
 * npm has already started Node to run this launcher, so falling back is a
 * plain `import()` of the server into THIS process: no extra spawn, no extra
 * startup, byte-identical to invoking dist/index.js directly. Finding the
 * candidates is stat-only, so a machine without oam never pays for a
 * subprocess.
 *
 * WHAT THE OAM PATH COSTS
 * Reaching oam through an npm `bin` means Node boots first, every oam binary
 * found is asked for its version, and then oam boots to serve -- so the
 * launcher is slower than pointing a host at oam directly. Measured on
 * npmjs-mcp (windows-arm64, n=12 medians, spawn to first MCP initialize):
 * oam 116ms, node 172ms, launcher 243ms. It exists for `npx` convenience.
 *
 * For an MCP host config, point straight at oam and skip this file:
 *   { "command": "oam", "args": ["run", "<abs>/dist/index.js"] }
 * That also skips the version floor below, so it is on the host to run an oam
 * at or above it. The server checks the one thing an older oam breaks outright:
 * over TLS on an oam below 0.15.3, every tool call returns an error naming the
 * version to update to, instead of the process crashing.
 *
 * WHICH OAM
 * OAM_BIN, when set and usable, is used as given. Otherwise every oam binary
 * discovery can see -- the installed locations, then PATH -- is asked for its
 * version, and the NEWEST one at or above the floor wins; a tie keeps search
 * order. Taking the first binary found instead let a stale copy early in the
 * search order hide a current one later: with oam 0.9.0 installed in ~/.oam/bin
 * and 0.15.2 on PATH, the launcher bound to 0.9.0 because installed locations
 * are searched first.
 *
 * An OAM_BIN that does not exist, is below the floor, or will not run is named
 * on stderr and discovery carries on. It used to stop everything: a path that
 * did not exist meant Node, with no hint why.
 *
 * ALREADY RUNNING ON OAM
 * A host can resolve this package's `bin` and launch `oam run <this file>`
 * instead of `node <this file>` -- Yaw MCP does, and so does oam's sidecar
 * regression matrix. When `process.versions.oam` clears the floor, the server
 * is imported into THIS process exactly as the Node fallback is -- no
 * discovery, no `oam --version` probe, no second oam. OAM_BIN is a discovery
 * input, so it is not consulted on that path: the host has already chosen
 * which oam runs.
 *
 * REDIS_MCP_SANDBOX=1 skips that shortcut and takes the discovery path,
 * deliberately: `--permission` is a process-level flag that only a FRESH oam
 * can apply, so serving in-process there would drop the sandbox, and the
 * REDIS_URL-pinned net grant with it, without a word -- a security downgrade
 * dressed up as an optimisation.
 *
 * A host oam BELOW the floor never serves. It used to, whenever discovery came
 * up empty. It now hands the server off to the newest usable oam, or to Node
 * found on PATH, or exits with an error when there is neither.
 *
 * A spawn from an oam host PIPES stdio rather than inheriting it. Before 0.9.0
 * oam treated `stdio: 'inherit'` as `'pipe'`, so an inherited handoff from such
 * a host connected the child to pipes nobody reads: measured with a real oam
 * 0.8.2 host, the MCP handshake never answered. Piping the streams explicitly
 * completes it, to both oam and Node, and it is used for every oam host --
 * including a supported one spawning a fresh oam for the sandbox -- so there is
 * one rule. A Node host keeps `inherit`, which hands over the same fds
 * untouched.
 *
 * The discovery path is not a guaranteed spawn. When it finds no usable oam,
 * or the one it chose fails to launch, REDIS_MCP_RUNTIME=auto falls back: in
 * THIS process on a Node host, or on a host oam at or above the floor (which
 * only reaches discovery under REDIS_MCP_SANDBOX=1), and handed off to Node
 * from a host oam below it. None of those fallbacks carries --permission: the
 * sandbox is not applied. A note is written when the fallback passed something
 * over -- an unusable OAM_BIN (named even when discovery then finds a usable
 * oam), and, only when no usable oam was found, each oam that was too old or
 * would not run and any Windows oam.cmd/.bat shim -- when the chosen oam
 * failed to launch, whenever a host oam below the floor hands off to Node, and
 * whenever REDIS_MCP_SANDBOX=1 was asked for. Every note under
 * REDIS_MCP_SANDBOX=1 says the sandbox was not applied, and a note that passed
 * over a working oam that is only too old says to update it. A below-floor
 * host's handoff is one message, written once the launcher knows whether a
 * Node was found, so it never announces a fallback that then does not happen.
 * With no oam found at all and no sandbox asked for, on a Node host or a
 * supported oam host, the fallback is silent. REDIS_MCP_RUNTIME=oam turns every
 * one of those fallbacks into a hard exit instead, so set it alongside
 * REDIS_MCP_SANDBOX=1 when an unsandboxed server is not acceptable.
 *
 * THE `--permission` SANDBOX (opt-in)
 * `REDIS_MCP_SANDBOX=1` runs a spawned oam under its permission model. It
 * cannot sandbox a server that ends up in-process or on Node -- see the
 * discovery-path fallback under ALREADY RUNNING ON OAM.
 *
 * The net grant is DERIVED from REDIS_URL at launch, for the same reason as
 * postgres-mcp: the one endpoint it may reach is the one it was pointed at, with
 * host and port both pinned: a grant naming only a host admits every port on a
 * hostname or IPv4 address, and nothing at all on an IPv6 literal. Filesystem
 * and child-process stay denied. When REDIS_URL names no single TCP endpoint
 * the grant can spell -- a unix socket path, a URL that does not parse, an
 * empty host, a host with a comma in it, a port outside 1-65535 -- the grant is
 * left open and the launcher says so.
 *
 * Opt-in, not default: a denied environment variable is ABSENT from process.env
 * rather than throwing, so an under-granted REDIS_URL reads as "not configured".
 * The env list is derived from the shipped bundle.
 *
 * MINIMUM OAM VERSION
 * The latest oam release, 0.15.3 -- bump OAM_MIN when oam ships a newer one.
 * Only the current oam is used and verified; an older one is passed over.
 * The floor is not cosmetic. Through 0.15.2 oam's `tls.TLSSocket` lacked the
 * `net.Socket` members ioredis calls (`setNoDelay`, `setKeepAlive`,
 * `setTimeout`, `connecting`) and never closed after the server hung up, so a
 * `rediss://` URL crashed the server on its first command (YawLabs/oam#132,
 * fixed in #141); it also ignored NODE_EXTRA_CA_CERTS (#136). The server
 * carried a socket shim for those until the floor reached 0.15.3, which has
 * both fixes; it now refuses TLS on an older oam itself, for the hosts that run
 * dist/index.js without this launcher. Before 0.9.0 `child_process.execFile` ran its
 * arguments through a SHELL, `exec` accepted `timeout` and ignored it,
 * `spawnSync` truncated at `maxBuffer` while reporting success, and
 * `stdio: 'inherit'`/`'ignore'` both behaved as `'pipe'`. This server spawns
 * nothing, so those were not reachable from it; the sandbox is what the older
 * releases undermine here. Per oam's changelog, `--permission` did not cover
 * the whole `fs` surface or `child_process` until 0.9.1, and a net grant was
 * not exact -- `--allow-net=127.0.0.1:5432` also granted port 54321 -- until
 * 0.15.0.
 *
 * SELECTION
 *   REDIS_MCP_RUNTIME=auto   newest usable oam, else Node (default)
 *   REDIS_MCP_RUNTIME=oam    newest usable oam, else exit with an error
 *                            (already running on oam at the floor satisfies it,
 *                            except under REDIS_MCP_SANDBOX=1)
 *   REDIS_MCP_RUNTIME=node   Node: in THIS process on Node, handed off to Node
 *                            on PATH when THIS process is oam
 *   REDIS_MCP_SANDBOX=1      run a spawned oam under --permission;
 *                            NOT applied when auto falls back
 *   OAM_BIN=/path/to/oam     use this oam when it is usable, before discovery
 * The runtime value is case-insensitive; anything else behaves like `auto`.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { constants, homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Oldest oam this server is used and verified on. See MINIMUM OAM VERSION above. */
const OAM_MIN = [0, 15, 3];

/**
 * Bound on each `oam --version` probe. A healthy oam answers in milliseconds;
 * the bound only exists so a wedged binary on PATH cannot hang the launch.
 */
const VERSION_PROBE_TIMEOUT_MS = 5_000;

// Two forms, deliberately. `import()` on Windows REJECTS a bare `C:\...` path
// with ERR_UNSUPPORTED_ESM_URL_SCHEME (it reads `c:` as a protocol), so the
// in-process fallback must use the file:// URL. spawn() needs a real path.
const SERVER_URL = new URL("../dist/index.js", import.meta.url);
const SERVER_ENTRY = fileURLToPath(SERVER_URL);
const isWin = process.platform === "win32";
const exe = isWin ? "oam.exe" : "oam";

/** Identity for de-duplicating paths: resolved, and case-folded on Windows. */
function pathKey(p) {
  let key = p;
  try {
    key = realpathSync(p);
  } catch {
    // Unresolvable: fall back to the literal path.
  }
  return isWin ? key.toLowerCase() : key;
}

/**
 * Every oam binary discovery can see, in search order, de-duplicated. Stat-only,
 * never a subprocess.
 *
 * Installed locations come BEFORE PATH, so when two binaries report the same
 * version the installed copy wins the tie. Someone who develops oam itself
 * usually has oam/target/release on PATH, and cargo replaces that binary
 * underneath running processes. Both forms are checked on Windows: the
 * installer defaults to %LOCALAPPDATA%\oam\bin there, but oam's docs name
 * ~/.oam/bin first and OAM_INSTALL_DIR can pick either.
 *
 * PATH is resolved manually rather than by spawning `which`/`where`, which
 * would cost a subprocess on every launch just to list candidates.
 *
 * Windows: `.exe` ONLY -- deliberately narrower than PATHEXT. Node refuses to
 * run a .cmd/.bat through execFile/spawn without `shell: true` (EINVAL, and for
 * spawn it throws SYNCHRONOUSLY rather than emitting 'error'), so walking the
 * full PATHEXT list would hand back a path this launcher cannot execute. A
 * skipped shim is named on stderr when no usable oam is found -- see
 * findOamShim.
 */
function discoverOamPaths() {
  const installed = [join(homedir(), ".oam", "bin", exe)];
  if (isWin) {
    installed.unshift(join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "oam", "bin", exe));
  }
  const onPath = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, exe));
  const seen = new Set();
  const found = [];
  for (const candidate of [...installed, ...onPath]) {
    if (!existsSync(candidate)) continue;
    const key = pathKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(candidate);
  }
  return found;
}

/**
 * Version text -> [major, minor, patch], or null when it holds no version.
 * A pre-release suffix (0.9.0-rc.1) truncates to its base version.
 *
 * Shared by the two places a version is read -- a discovered binary's
 * `oam --version` output ("oam 0.15.1") and the host's own
 * `process.versions.oam` ("0.15.1") -- so they cannot disagree about what a
 * version string means, or which floor it has to clear.
 */
function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** `oam --version` -> [major, minor, patch], or null when it cannot be read. */
function oamVersion(cmd) {
  try {
    const out = execFileSync(cmd, ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: VERSION_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    return parseVersion(out);
  } catch {
    // Not executable, wrong arch, wedged, or deleted since the stat. Caller degrades.
    return null;
  }
}

/** True when `v` is at least `min`, comparing major/minor/patch in order. */
function atLeast(v, min) {
  if (!v) return false;
  for (let i = 0; i < min.length; i++) {
    if (v[i] > min[i]) return true;
    if (v[i] < min[i]) return false;
  }
  return true;
}

/**
 * The newest candidate at or above the floor, or null. `candidates` is
 * `{ path, version }[]` in search order, `version` null when unreadable.
 * Strictly-greater replaces, so a tie keeps the earlier candidate.
 *
 * Pure on purpose, like runtimePlan: the choice is testable without binaries.
 */
function pickNewest(candidates) {
  let best = null;
  for (const candidate of candidates) {
    if (!atLeast(candidate.version, OAM_MIN)) continue;
    if (!best || !atLeast(best.version, candidate.version)) best = candidate;
  }
  return best;
}

/**
 * Where the server runs, decided BEFORE any discovery:
 *   "in-process"   import it into THIS process
 *   "discover"     choose an oam and spawn it, or fall back (see ALREADY
 *                  RUNNING ON OAM for where, and why it is unsandboxed)
 *   "handoff-node" hand it off to Node on PATH: THIS process is an oam and
 *                  Node was asked for
 *
 * `hostOam` is `process.versions.oam`: oam's own key, absent on Node. An oam
 * host whose version cannot be read is treated as below the floor -- it never
 * proved it is a supported oam. `sandbox` is whether a spawn would carry flags
 * only a fresh oam can apply; see ALREADY RUNNING ON OAM above for why that
 * alone forces the discovery path. The floor is OAM_MIN itself, not a
 * parameter, so a host oam and a discovered one can never be held to different
 * minimums.
 *
 * Pure on purpose: every input is passed in, so the whole decision is testable
 * without booting a runtime.
 */
function runtimePlan({ mode, hostOam, sandbox }) {
  const onOam = hostOam !== undefined;
  if (mode === "node") return onOam ? "handoff-node" : "in-process";
  if (sandbox) return "discover";
  return atLeast(parseVersion(hostOam ?? ""), OAM_MIN) ? "in-process" : "discover";
}

/**
 * The `--allow-net` flag that pins the sandbox to the endpoint in `dsn`
 * (REDIS_URL), and, when it cannot be pinned, why: `{ flag, open }`, where
 * `open` is null for a pinned grant and a short reason for an open one.
 *
 * Derived, not hardcoded: the only endpoint this server may reach is the one it
 * was configured to reach. oam (0.15.0 and later) matches a socket grant that
 * carries a port exactly, as a whole string, against "host:port". Always pin
 * both: a grant naming only a host admits every port on a hostname or IPv4
 * address, and admits nothing at all for an unbracketed IPv6 literal, whose
 * colons oam's host_of() cannot split (measured on 0.15.2 and 0.15.3:
 * `--allow-net=::1` denies ::1 port 6391).
 *
 * The grant must name exactly the host and port ioredis dials, because that is
 * what oam formats as the resource it checks (`format!("{host}:{port}")` over
 * the host string handed to net.connect, port as a number). So the host and
 * port are resolved here the way ioredis resolves them -- `parseURL` in
 * `ioredis/built/utils/index.js`, then `Redis.parseOptions` for the defaults
 * and the port's `parseInt`, then `StandaloneConnector` for socket-or-TCP:
 *
 *   - a DSN `isInt` accepts (`6391`, but also `6391 `, `+6391`, `6391.0`) is a
 *     port on ioredis's default host, localhost;
 *   - a DSN starting with `/`, a scheme-less DSN with a pathname
 *     (`host:6379/2`), or any DSN with a non-empty `path` in its query string
 *     is a unix socket path to ioredis, not a host;
 *   - a scheme-less DSN (`127.0.0.1:6379`, `:pw@host:6379`, `host`) is parsed
 *     as if it began with `redis://`;
 *   - WHATWG `URL#hostname` keeps the brackets on an IPv6 literal (`[::1]`)
 *     and ioredis strips them, so they come off here too -- from the URL's
 *     host only; a `host` from the query string is used verbatim. Both sides
 *     see the address already compressed by WHATWG (`[0:0:0:0:0:0:0:1]`
 *     becomes `[::1]`);
 *   - a `host` or `port` in the query string fills in whichever the URL itself
 *     did not name, and a repeated key resolves to its last value. A key that
 *     is present but empty (`?port=`) is kept as the empty string, exactly as
 *     ioredis keeps it, not treated as absent;
 *   - with no host anywhere (`redis:///0`, `redis://?port=6391`), the host is
 *     localhost; the port defaults to 6379 and is read with `parseInt`, so
 *     `06391` is 6391.
 *
 * Measured on oam 0.15.2 and 0.15.3: `--allow-net=[::1]:6391` denies a
 * connect to ::1 port 6391 (`resource: '::1:6391'`); `--allow-net=::1:6391`
 * admits it and still denies ::1 port 63910. There is no host/port ambiguity
 * to resolve in the IPv6 case, because the match is a whole-string comparison,
 * not a parse.
 *
 * What is left gets a bare `--allow-net` rather than a guessed narrow one, and
 * the caller reports that the sandbox's network is open:
 *
 *   - a unix socket path, which is not a network endpoint at all;
 *   - a DSN WHATWG rejects (`redis://[::1`), which ioredis rejects the same way;
 *   - an empty host (`?host=`): ioredis passes `""` to net.connect, and which
 *     address that becomes is up to the runtime, not something to encode here;
 *   - a host oam's grant list cannot spell: oam splits an `--allow-net` value
 *     on commas and trims each entry, so `redis://a,b:6391` would become a
 *     grant for every port on `a` -- a silent widening, where an open grant at
 *     least says so;
 *   - a port that is not a number from 1 to 65535 (`?port=`, `:0`, `70000`).
 *     Node refuses to dial one; oam (0.15.2 and 0.15.3) does not refuse, it
 *     clamps -- 70000 dials 65535, and a TLS port 0 dials 443 -- so there is
 *     no port the user named that a grant could honestly pin.
 *
 * A wrong narrow grant fails at connect time with a denial that does not name
 * the cause; the open grant lets the server's own error through. `open` never
 * contains the URL: it can carry a password.
 */
function netGrant(dsn) {
  const open = (reason) => ({ flag: "--allow-net", open: reason });
  const socketPath = () => open("REDIS_URL names a unix socket path, not a host");
  if (!dsn || dsn.trim() === "") return open("REDIS_URL is not set");
  // ioredis's isInt: anything Number() reads as an integer, whitespace and
  // sign included, is a port on localhost.
  const asNumber = Number.parseFloat(dsn);
  if (!Number.isNaN(Number(dsn)) && (asNumber | 0) === asNumber) {
    return pinned("localhost", dsn);
  }
  if (dsn.startsWith("/")) return socketPath();
  const hasScheme = /^rediss?:\/\//i.test(dsn);
  let url;
  try {
    url = new URL(hasScheme ? dsn : `redis://${dsn}`);
  } catch {
    return open("REDIS_URL is not a URL this launcher can parse");
  }
  // Only a scheme-less DSN's pathname is a socket path; on `redis://` it is
  // the db number.
  if (!hasScheme && url.pathname && url.pathname !== "/") return socketPath();
  // The last value of a query key, or undefined when the key is absent. An
  // empty value stays "", because ioredis keeps it.
  const query = (key) => url.searchParams.getAll(key).at(-1);
  if (query("path")) return socketPath();
  const queryHost = query("host");
  if (!url.hostname && queryHost === "") return open("REDIS_URL names an empty host");
  const host = url.hostname ? url.hostname.replace(/^\[|\]$/g, "") : (queryHost ?? "localhost");
  return pinned(host, url.port || (query("port") ?? "6379"));

  function pinned(host, rawPort) {
    if (host.includes(",") || host !== host.trim()) {
      return open("REDIS_URL names a host the sandbox's network grant cannot express");
    }
    const port = Number.parseInt(rawPort, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return open("REDIS_URL names a port that is not a number from 1 to 65535");
    }
    return { flag: `--allow-net=${host}:${port}`, open: null };
  }
}

/**
 * The `--permission` grant list, or [] when the sandbox is not requested.
 *
 * These are oam's PROCESS-level flags: they belong before the `run` subcommand,
 * not after it. `oam run --permission file.js` is rejected outright, which is a
 * good failure but only because it is loud -- ordering here is load-bearing.
 *
 * The net grant comes from `netGrant` above.
 * A denied environment variable is ABSENT from process.env rather than throwing,
 * so the env list below is derived from what the bundle actually reads; trimming
 * it produces silent misbehaviour, not a clear denial.
 */
function sandboxFlags() {
  if (process.env.REDIS_MCP_SANDBOX !== "1") return [];

  const netFlag = netGrant(process.env.REDIS_URL).flag;

  const env = ["ALLOW_WRITES","DEBUG","REDIS_COMMAND_TIMEOUT_MS","REDIS_CONNECT_TIMEOUT_MS","REDIS_MAX_KEYS","REDIS_MAX_VALUE_BYTES","REDIS_SCAN_COUNT","REDIS_TLS_REJECT_UNAUTHORIZED","REDIS_URL"];

  const flags = ["--permission", netFlag, `--allow-env=${env.join(",")}`];
  return flags;
}

/**
 * Write a diagnostic to stderr synchronously, so a following process.exit
 * cannot truncate it.
 *
 * Not a bare writeSync: that call can short-write (it returns a byte count) and
 * on macOS it can throw EAGAIN, because Node makes a piped stderr non-blocking
 * there rather than blocking the write. Loop over the remaining bytes, and if
 * stderr turns out to be unusable give up quietly -- failing to print a
 * diagnostic is not worth crashing a stdio server over.
 */
async function errSync(message) {
  const { writeSync } = await import("node:fs");
  const buf = Buffer.from(message);
  let off = 0;
  for (let attempts = 0; off < buf.length && attempts < 1000; attempts++) {
    try {
      off += writeSync(2, buf, off, buf.length - off);
    } catch (err) {
      if (err?.code !== "EAGAIN") return;
      // Pipe is full and the reader has not drained yet -- retry.
    }
  }
}

/**
 * An oam-named .cmd/.bat on PATH: a real install in a shape this launcher
 * cannot spawn. Named on stderr when no usable oam is found, rather than
 * ignored, because "no oam binary was found" reads as "install oam" -- the one
 * thing that will not help. Windows only;
 * there is no such shim concept on POSIX.
 */
function findOamShim() {
  if (!isWin) return null;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of [".cmd", ".bat"]) {
      const candidate = join(dir, `oam${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** A Node binary on PATH, or null. Stat-only; used only when THIS process is oam. */
function findNodeOnPath() {
  const name = isWin ? "node.exe" : "node";
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Why a candidate was passed over, for stderr. */
function unusableReason(path, version, label = path) {
  const min = OAM_MIN.join(".");
  return version
    ? `${label} is oam ${version.join(".")}, older than ${min}`
    : `${label} could not be run, or did not report a version this launcher understands`;
}

/**
 * Choose the oam to spawn: a usable OAM_BIN, else the newest usable discovered
 * binary. Returns the choice (or null) plus stderr notes: `overrideNote` about
 * an unusable OAM_BIN, and `skipped` describing what was found and rejected
 * when nothing was usable. `outdated` is true when anything rejected was a
 * working oam that is merely below the floor -- the case an update fixes.
 */
function chooseOam() {
  const override = process.env.OAM_BIN;
  let overrideNote = null;
  let outdated = false;
  if (override) {
    if (!existsSync(override)) {
      overrideNote = `OAM_BIN=${override} does not exist`;
    } else {
      const version = oamVersion(override);
      if (atLeast(version, OAM_MIN)) {
        return { chosen: { path: override, version }, overrideNote, skipped: [], outdated };
      }
      overrideNote = unusableReason(override, version, `OAM_BIN=${override}`);
      outdated ||= version !== null;
    }
  }
  const overrideKey = override ? pathKey(override) : null;
  const candidates = discoverOamPaths()
    .filter((path) => pathKey(path) !== overrideKey)
    .map((path) => ({ path, version: oamVersion(path) }));
  const chosen = pickNewest(candidates);
  const skipped = chosen ? [] : candidates.map((c) => unusableReason(c.path, c.version));
  if (!chosen) outdated ||= candidates.some((c) => c.version !== null);
  return { chosen, overrideNote, skipped, outdated };
}

/** Run the server in THIS process. The zero-overhead fallback. */
async function runInProcess() {
  // A server may gate its bootstrap on being the process ENTRY POINT --
  // `import.meta.url === pathToFileURL(process.argv[1]).href` -- so that its own
  // test file can import the module for unit tests without connecting a stdio
  // transport. aws-mcp does exactly this. Importing the server here would leave
  // argv[1] pointing at THIS launcher, the guard would read false, and the
  // server would load but never serve: the MCP handshake just hangs.
  //
  // Point argv[1] at the server first, so the in-process path is
  // indistinguishable from having executed the file directly. The spawn path
  // needs no equivalent -- there argv[1] is already the server.
  process.argv[1] = SERVER_ENTRY;
  await import(SERVER_URL.href);
}

// ONE reporter for every failed in-process fallback. runInProcess() is a bare
// import() that rejects when dist/index.js is missing, and at ESM top level an
// unhandled rejection is an uncaught exception -- replacing this launcher's
// diagnostic with a raw stack trace.
const fallbackFailed = (e) => {
  process.stderr.write(`redis-mcp: fallback to Node failed (${e?.message ?? e})\n`);
  process.exitCode = 1;
};

/**
 * Spawn the server in a child runtime and mirror its lifetime.
 *
 * `onLaunchFailed(err)` runs when the child could not be started at all; it is
 * never called once the child is running, which would double-start the server
 * on the same stdio.
 */
async function launchChild(cmd, args, onLaunchFailed) {
  // THIS process being an oam means one below the floor, a supported one
  // spawning a fresh oam for REDIS_MCP_SANDBOX=1, or any oam handing off to
  // Node under REDIS_MCP_RUNTIME=node (a supported oam host serves in-process
  // otherwise). Pipe explicitly for every oam host: a below-floor oam's
  // `stdio: 'inherit'` does not hand over the fds. See ALREADY RUNNING ON OAM.
  const piped = process.versions.oam !== undefined;
  let child = null;
  try {
    child = spawn(cmd, args, {
      // inherit keeps the SAME fds, so MCP's newline-delimited JSON framing on
      // stdin/stdout is untouched and the host's stdin-close still reaches the
      // server's shutdown path. Piping preserves both as well: bytes are copied
      // unchanged, and stdin's end propagates to the child.
      stdio: piped ? ["pipe", "pipe", "pipe"] : "inherit",
      env: process.env,
      windowsHide: true,
    });
  } catch (err) {
    // spawn() THROWS for some failures instead of emitting 'error', and the
    // 'error' listener is registered AFTER this call, so it can never observe
    // one -- an uncaught throw here kills the launcher with a raw stack trace
    // instead of falling back.
    await onLaunchFailed(err).catch(fallbackFailed);
    return;
  }

  // If the runtime cannot be executed at all (deleted between the version probe
  // and the spawn, wrong arch, permission), fall back rather than failing the
  // whole server. `spawned` prevents falling back AFTER the child started.
  //
  // Everything that assumes a live child waits for 'spawn'. A failed spawn
  // still emits 'close' (after 'error', with the negative errno as its code), so
  // an unguarded close handler would process.exit() out from under the fallback
  // onLaunchFailed has just started -- and stdin piped into a child that never
  // ran would swallow the host's first bytes before the fallback could read
  // them. Until 'spawn', process.stdin has no reader and simply stays paused.
  let spawned = false;
  child.on("spawn", () => {
    spawned = true;
    if (piped) {
      process.stdin.pipe(child.stdin);
      child.stdout.pipe(process.stdout);
      child.stderr.pipe(process.stderr);
    }
    forwardSignals();
  });
  child.on("error", (err) => {
    if (spawned) return;
    onLaunchFailed(err).catch(fallbackFailed);
  });
  // A child that exits before reading everything closes its stdin; the
  // resulting EPIPE is not worth crashing over.
  child.stdin?.on("error", () => {});

  // Forward termination so the server's own shutdown path runs in the child
  // rather than the child being orphaned.
  //
  // Registering ANY handler for these suppresses Node's default
  // terminate-on-signal, so the parent's exit has to be arranged explicitly.
  // `child.killed` only records that kill() was CALLED, never that the child
  // is gone, so gating on it swallows every signal after the first and wedges
  // the launcher with no escape hatch.
  //
  // Escalation is driven by a TIMER, not by counting signals. Counting is
  // ambiguous: a supervisor routinely sends SIGINT then SIGTERM milliseconds
  // apart, and a terminal Ctrl-C reaches the whole process group, so reading
  // "a second signal" as impatience hard-kills a child that is already
  // shutting down cleanly. A timer makes the count irrelevant -- ONE press is
  // enough, and a wedged child dies on schedule. setTimeout is monotonic, so
  // a wall-clock step cannot mis-gate the window either.
  //
  // POSIX vs Windows, and why we do NOT forward on Windows.
  // On POSIX child.kill(sig) delivers a real, catchable signal, so forwarding
  // is what lets the child run its shutdown. On Windows there are no POSIX
  // signals: child.kill IGNORES the name and calls TerminateProcess -- an
  // immediate hard kill (verified: a child with a SIGTERM handler never runs
  // it and dies with code=null, signal=SIGTERM). Forwarding there ABORTS the
  // graceful shutdown the console's own Ctrl-C just started, skipping the
  // child's process.on("exit") cleanup. The console has already notified the
  // child, so on Windows the timer below is the only kill we issue.
  const ESCALATE_AFTER_MS = 2000;
  let escalation = null;
  function forwardSignals() {
    for (const sig of ["SIGINT", "SIGTERM"]) {
      process.on(sig, () => {
        // No try/catch: kill() on an already-exited child returns false, it does
        // not throw. It throws only for a signal the platform does not know,
        // which SIGINT/SIGTERM/SIGKILL never are.
        if (!isWin) child.kill(sig);
        if (escalation) return; // already counting down; further signals are noise
        escalation = setTimeout(() => {
          // Still here after its grace window. Stop waiting on it.
          child.kill("SIGKILL");
          process.exit(128 + (constants.signals[sig] ?? 15));
        }, ESCALATE_AFTER_MS);
      });
    }
  }

  // Piped: wait for 'close', so the child's last stdout bytes are copied out
  // before this process exits. Inherited: 'exit' is enough, the fds were never
  // ours to drain. Either way, only for a child that actually ran -- see the
  // 'spawn' handler above.
  child.on(piped ? "close" : "exit", (code, signal) => {
    if (!spawned) return;
    if (escalation) clearTimeout(escalation);
    // Mirror the child's fate: a signal death becomes 128+n so callers see a
    // conventional shell exit status rather than a bare 0.
    if (signal) {
      process.exit(128 + (constants.signals[signal] ?? 15));
    }
    process.exit(code ?? 0);
  });
}

/**
 * Hand the server to Node on PATH. Only reachable when THIS process is oam --
 * one below the floor, or any oam under REDIS_MCP_RUNTIME=node -- so there is
 * no in-process option left.
 */
async function handOffToNode(reason, remedy = "") {
  const node = findNodeOnPath();
  if (!node) {
    await errSync(
      `redis-mcp: ${reason}, and no Node was found on PATH to run the server instead.\n` +
        `Run \`oam self-update\` to get oam ${OAM_MIN.join(".")} or newer, or launch this command with node.\n`,
    );
    process.exit(1);
  }
  if (reason) await errSync(`redis-mcp: ${reason}; running on ${node} instead${remedy ? `; ${remedy}` : ""}.\n`);
  await launchChild(node, [SERVER_ENTRY, ...process.argv.slice(2)], async (err) => {
    await errSync(`redis-mcp: failed to launch Node at ${node} (${err?.message ?? err})\n`);
    process.exit(1);
  });
}

/**
 * Whether a host oam may serve the server itself: present, and at or above the
 * floor. Such a host only reaches discovery under REDIS_MCP_SANDBOX=1.
 */
function hostOamServes(hostOam) {
  return hostOam !== undefined && atLeast(parseVersion(hostOam), OAM_MIN);
}

/**
 * What an `auto` fallback does, for stderr, or null when THIS process is an
 * oam below the floor: that fallback is a handoff to Node on PATH, which may
 * not exist, so handOffToNode reports what actually happened instead of this
 * note promising it. No fallback applies the sandbox, and every note says so
 * when it was asked for.
 */
function fallbackAction(hostOam) {
  if (hostOamServes(hostOam)) return `serving in-process on this oam ${hostOam}, without --permission`;
  if (hostOam !== undefined) return null;
  return sandboxFlags().length > 0 ? "using Node instead, without --permission" : "using Node instead";
}

/** A note, with the fallback action appended when there is one. */
function withAction(note, hostOam) {
  const action = fallbackAction(hostOam);
  return action ? `${note}; ${action}` : note;
}

/** The remedy for a working oam that is only too old, for stderr. */
const UPDATE_OAM = `update oam from https://oamjs.org to use it (${OAM_MIN.join(".")} or newer)`;

/**
 * No usable oam, under a mode that allows falling back: in THIS process on a
 * Node host or a supported oam host, handed off to Node from a host oam below
 * the floor. None of them applies the sandbox. `why` leads the handoff's own
 * message, which is the only one printed on that path.
 */
async function fallBack(hostOam, why = "no newer oam was found") {
  if (hostOam === undefined || hostOamServes(hostOam)) {
    await runInProcess();
    return;
  }
  const sandbox = sandboxFlags().length > 0 ? " (REDIS_MCP_SANDBOX=1 is not applied on Node)" : "";
  await handOffToNode(`this process is oam ${hostOam}, older than ${OAM_MIN.join(".")}, and ${why}${sandbox}`, UPDATE_OAM);
}

const mode = (process.env.REDIS_MCP_RUNTIME ?? "auto").toLowerCase();
const hostOam = process.versions.oam;

// The sandbox is read off the grant list rather than REDIS_MCP_SANDBOX, so
// "would the spawn carry --permission" cannot drift from what the spawn below
// actually passes.
const plan = runtimePlan({ mode, hostOam, sandbox: sandboxFlags().length > 0 });

if (plan === "in-process") {
  await runInProcess();
} else if (plan === "handoff-node") {
  const belowFloor = !atLeast(parseVersion(hostOam), OAM_MIN);
  await handOffToNode(belowFloor ? `this process is oam ${hostOam}, older than ${OAM_MIN.join(".")}` : "");
} else {
  const { chosen, overrideNote, skipped, outdated } = chooseOam();

  if (chosen) {
    if (overrideNote) {
      await errSync(`redis-mcp: ${overrideNote}; using ${chosen.path} (oam ${chosen.version.join(".")}).\n`);
    }
    // A sandbox whose network grant silently opened up would be worse than no
    // note at all. Only when the sandbox is actually about to be applied, and
    // only for a REDIS_URL that is set: an unset or blank one fails in the
    // server with its own, clearer message.
    const grant = netGrant(process.env.REDIS_URL);
    if (sandboxFlags().length > 0 && grant.open && process.env.REDIS_URL?.trim()) {
      await errSync(
        `redis-mcp: REDIS_MCP_SANDBOX=1, but ${grant.open}, so the sandbox cannot pin its network grant to the Redis endpoint and leaves network access open.\n`,
      );
    }
    // `--` separates oam's own flags from the script's argv, so `redis-mcp
    // --version` and any host-supplied flags survive the hop unchanged. The
    // sandbox flags are process-level, so they go BEFORE `run`.
    await launchChild(
      chosen.path,
      [...sandboxFlags(), "run", SERVER_ENTRY, "--", ...process.argv.slice(2)],
      async (err) => {
        if (mode === "oam") {
          await errSync(`redis-mcp: failed to launch oam at ${chosen.path} (${err?.message ?? err})\n`);
          process.exit(1);
        }
        await errSync(`redis-mcp: ${withAction(`failed to launch oam at ${chosen.path} (${err?.message ?? err})`, hostOam)}.\n`);
        await fallBack(hostOam, `the newer oam at ${chosen.path} could not be launched`);
      },
    );
  } else {
    const shim = findOamShim();
    const notes = [
      ...(overrideNote ? [overrideNote] : []),
      ...skipped,
      ...(shim
        ? [`found ${shim}, but Node cannot execute a .cmd/.bat directly -- install the native oam binary, or point OAM_BIN at one`]
        : []),
    ];
    if (mode === "oam") {
      await errSync(
        `redis-mcp: REDIS_MCP_RUNTIME=oam but no usable oam (${OAM_MIN.join(".")} or newer) was found.\n` +
          notes.map((note) => `  ${note}\n`).join("") +
          "Install or update from https://oamjs.org, set OAM_BIN=/path/to/oam, or use REDIS_MCP_RUNTIME=node.\n",
      );
      process.exit(1);
    }
    // auto: falling back is correct, but silence is how someone never learns
    // their OAM_BIN is wrong, their oam is too old to use, or their sandbox
    // was not applied.
    if (hostOam !== undefined && !hostOamServes(hostOam)) {
      // An oam below the floor hands off to Node, and handOffToNode is the one
      // message: it knows whether a Node was found, so nothing printed first
      // can promise a fallback that then does not happen.
      const found = notes.length > 0 ? ` (${notes.join("; ")})` : "";
      await fallBack(hostOam, `no newer oam was found${found}`).catch(fallbackFailed);
    } else {
      const sandboxed = sandboxFlags().length > 0;
      if (notes.length > 0 || sandboxed) {
        const lead = notes.length > 0 ? notes.join("; ") : `REDIS_MCP_SANDBOX=1, but no oam ${OAM_MIN.join(".")} or newer was found`;
        const remedy = outdated ? `; ${UPDATE_OAM}` : "";
        await errSync(`redis-mcp: ${withAction(lead, hostOam)}${remedy}.\n`);
      }
      await fallBack(hostOam).catch(fallbackFailed);
    }
  }
}
