import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Redis } from "ioredis";

// Resolve via import.meta.url so this works regardless of process.cwd(). The
// compiled file lives in dist/, one level below the repo root, exactly like
// release-metadata.test.ts.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = resolve(REPO_ROOT, "bin", "redis-mcp.mjs");
const DIST_BIN = resolve(REPO_ROOT, "dist", "index.js");
const PACKAGE_VERSION = (JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8")) as { version: string })
  .version;

type Plan = "in-process" | "discover" | "handoff-node";
type RuntimePlan = (ctx: { mode: string; hostOam: string | undefined; sandbox: boolean }) => Plan;
type Candidate = { path: string; version: number[] | null };
type PickNewest = (candidates: Candidate[]) => Candidate | null;
type NetGrant = (dsn: string | undefined) => { flag: string; open: string | null };

/** Pull named declarations out of the launcher source, loudly. */
function extract(patterns: RegExp[]): string {
  const source = readFileSync(LAUNCHER, "utf-8");
  return patterns
    .map((pattern) => {
      const match = source.match(pattern);
      if (!match) throw new Error(`could not extract ${pattern} from bin/redis-mcp.mjs -- renamed or reformatted?`);
      return match[0];
    })
    .join("\n");
}

const OAM_MIN_DECL = /const OAM_MIN = \[[^\]]*\];/;
const ATLEAST_DECL = /function atLeast\(v, min\) \{[\s\S]*?\n\}/;

/**
 * Evaluate the REAL `runtimePlan` source, together with the declarations it
 * closes over, without importing the launcher.
 *
 * Why not import it: the launcher's module body resolves a runtime at import
 * time and either spawns oam or imports the server, so importing it from a
 * test would launch a server. Making it importable would mean gating that body
 * behind an entry-point check -- a behaviour change to a shipped runtime
 * artifact whose failure mode (the guard reads false under an npm shim, and the
 * launcher silently does nothing) is worse than the gap this closes. This is
 * the same idiom tailscale-mcp's launcher test uses.
 *
 * Extracting the text exercises the shipped logic rather than a copy that can
 * drift, and a failed extraction is a loud assertion, not a silent skip.
 */
function loadRuntimePlan(): RuntimePlan {
  const pieces = extract([
    OAM_MIN_DECL,
    /function parseVersion\(text\) \{[\s\S]*?\n\}/,
    ATLEAST_DECL,
    /function runtimePlan\(\{ mode, hostOam, sandbox \}\) \{[\s\S]*?\n\}/,
  ]);
  return new Function(`${pieces}\nreturn runtimePlan;`)() as RuntimePlan;
}

function loadPickNewest(): { pickNewest: PickNewest; floor: number[] } {
  const pieces = extract([OAM_MIN_DECL, ATLEAST_DECL, /function pickNewest\(candidates\) \{[\s\S]*?\n\}/]);
  return new Function(`${pieces}\nreturn { pickNewest, floor: OAM_MIN };`)() as {
    pickNewest: PickNewest;
    floor: number[];
  };
}

describe("launcher runtimePlan()", () => {
  const runtimePlan = loadRuntimePlan();

  it("serves in-process when already hosted on an oam at or above the floor", () => {
    // The bug this exists for: a host that launches `oam run bin/redis-mcp.mjs`
    // got a SECOND oam, because the launcher discovered and spawned one without
    // asking what it was already running on. `auto` and `oam` both have to take
    // the shortcut -- `oam` demands oam, and the host already is one.
    //
    // 0.15.2 pins the floor as inclusive (it IS the supported release), and
    // 0.100.0 pins a numeric compare: it sorts BEFORE 0.15.2 as a string, so a
    // compare over the raw text would treat a newer oam as too old.
    for (const mode of ["auto", "oam"]) {
      for (const hostOam of ["0.15.2", "0.16.0", "0.100.0", "1.0.0", "0.16.0-dev"]) {
        assert.equal(runtimePlan({ mode, hostOam, sandbox: false }), "in-process", `mode=${mode} hostOam=${hostOam}`);
      }
    }
  });

  it("keeps the discovery path when the sandbox is requested, even on a supported oam", () => {
    // `--permission` is a process-level flag: only a FRESH oam can apply it.
    // Serving in-process here would silently drop the sandbox the user asked
    // for, and the REDIS_URL-pinned net grant with it -- a security downgrade
    // that no other symptom would reveal. (Discovery that then finds no usable
    // oam still falls back under `auto`; see the launcher header.)
    for (const mode of ["auto", "oam"]) {
      for (const hostOam of ["0.15.2", "1.0.0"]) {
        assert.equal(runtimePlan({ mode, hostOam, sandbox: true }), "discover", `mode=${mode} hostOam=${hostOam}`);
      }
    }
  });

  it("never serves in-process on a host oam below the floor", () => {
    // Below the floor the host must hand off. Serving there was the bug: an oam
    // older than the latest release is not what the server is verified on, and
    // below 0.15.0 the sandbox's pinned net grant was not exact.
    for (const mode of ["auto", "oam"]) {
      for (const sandbox of [false, true]) {
        for (const hostOam of ["0.15.1", "0.9.0", "0.8.2", "0.0.1"]) {
          assert.equal(
            runtimePlan({ mode, hostOam, sandbox }),
            "discover",
            `mode=${mode} hostOam=${hostOam} sandbox=${sandbox}`,
          );
        }
      }
    }
  });

  it("discovers as before on Node, where process.versions has no oam key", () => {
    // An unreadable value must not count as "new enough" either: that would
    // skip discovery on a host that never proved it is a supported oam.
    for (const mode of ["auto", "oam"]) {
      for (const hostOam of [undefined, "", "dev"]) {
        assert.equal(runtimePlan({ mode, hostOam, sandbox: false }), "discover", `mode=${mode} hostOam=${hostOam}`);
      }
    }
  });

  it("runs REDIS_MCP_RUNTIME=node on Node: in-process on a Node host, handed off from any oam host", () => {
    for (const sandbox of [false, true]) {
      assert.equal(runtimePlan({ mode: "node", hostOam: undefined, sandbox }), "in-process", `sandbox=${sandbox}`);
      for (const hostOam of ["0.8.2", "0.15.2", "1.0.0", "dev"]) {
        assert.equal(
          runtimePlan({ mode: "node", hostOam, sandbox }),
          "handoff-node",
          `hostOam=${hostOam} sandbox=${sandbox}`,
        );
      }
    }
  });
});

describe("launcher pickNewest()", () => {
  const { pickNewest, floor } = loadPickNewest();
  const at = (path: string, version: number[] | null): Candidate => ({ path, version });

  it("pins the floor to the latest oam release", () => {
    assert.deepEqual(floor, [0, 15, 2]);
  });

  it("takes the newest usable oam, not the first one found", () => {
    // The bug: discovery stopped at the first binary that existed, so an older
    // copy in an earlier location (the installed dir is searched before PATH)
    // hid a newer one later.
    const chosen = pickNewest([at("installed", [0, 15, 2]), at("path-a", [0, 16, 0]), at("path-b", [0, 15, 9])]);
    assert.equal(chosen?.path, "path-a");
  });

  it("compares numerically and keeps search order on a tie", () => {
    assert.equal(pickNewest([at("a", [0, 16, 0]), at("b", [0, 100, 0])])?.path, "b");
    assert.equal(pickNewest([at("first", [0, 15, 2]), at("second", [0, 15, 2])])?.path, "first");
  });

  it("skips binaries below the floor or with no readable version", () => {
    assert.equal(pickNewest([at("old", [0, 9, 0]), at("broken", null), at("good", [0, 15, 2])])?.path, "good");
    assert.equal(pickNewest([at("old", [0, 15, 1]), at("broken", null)]), null);
    assert.equal(pickNewest([]), null);
  });
});

describe("launcher netGrant()", () => {
  const netGrant = new Function(
    `${extract([/function netGrant\(dsn\) \{[\s\S]*?\n\}/])}\nreturn netGrant;`,
  )() as NetGrant;

  it("pins an IPv6 literal without its brackets, the way oam spells the resource", () => {
    // The bug (#14): WHATWG `URL#hostname` keeps the brackets, so the launcher
    // passed `--allow-net=[::1]:6391`, which oam never matches -- oam checks
    // `::1:6391` -- and every connection was denied.
    assert.deepEqual(netGrant("redis://[::1]:6391"), { flag: "--allow-net=::1:6391", open: null });
    assert.deepEqual(netGrant("rediss://user:pw@[2001:db8::1]/0"), {
      flag: "--allow-net=2001:db8::1:6379",
      open: null,
    });
    // WHATWG compresses the address first, so the grant is the canonical form.
    assert.deepEqual(netGrant("redis://[0:0:0:0:0:0:0:1]:6391"), { flag: "--allow-net=::1:6391", open: null });
  });

  it("pins host and port for hostnames and IPv4, defaulting to 6379", () => {
    assert.deepEqual(netGrant("redis://127.0.0.1:6391"), { flag: "--allow-net=127.0.0.1:6391", open: null });
    assert.deepEqual(netGrant("redis://:secret@cache.internal/2"), {
      flag: "--allow-net=cache.internal:6379",
      open: null,
    });
  });

  it("pins the DSN shapes ioredis accepts without a scheme, instead of opening the grant", () => {
    // ioredis parses anything without `redis://` or `rediss://` as if it had
    // `redis://` in front, and a bare integer as a port on localhost. A grant
    // left open here is a sandbox that quietly allows every host.
    assert.deepEqual(netGrant("127.0.0.1:6379"), { flag: "--allow-net=127.0.0.1:6379", open: null });
    assert.deepEqual(netGrant(":hunter2@127.0.0.1:6379"), { flag: "--allow-net=127.0.0.1:6379", open: null });
    assert.deepEqual(netGrant("cache.internal"), { flag: "--allow-net=cache.internal:6379", open: null });
    assert.deepEqual(netGrant("6391"), { flag: "--allow-net=localhost:6391", open: null });
  });

  it("reads a bare port the way ioredis's isInt does: whitespace, a sign, or a .0 are still that port", () => {
    // A trailing newline or space on an env value is the realistic shape (a
    // .env line ending, `set X=6391 ` in a batch file). Each used to fall
    // through to the URL branch and pin a wrong host, which oam denied.
    for (const dsn of ["6391 ", "6391\n", "\t6391", "+6391", "6391.0", "06391"]) {
      assert.deepEqual(netGrant(dsn), { flag: "--allow-net=localhost:6391", open: null }, JSON.stringify(dsn));
    }
  });

  it("takes a host or port from the query string when the URL itself names none, as ioredis does", () => {
    assert.deepEqual(netGrant("redis://127.0.0.1?port=6391"), { flag: "--allow-net=127.0.0.1:6391", open: null });
    assert.deepEqual(netGrant("redis:///0?host=cache&port=7000"), { flag: "--allow-net=cache:7000", open: null });
    // The URL's own port wins over the query, as it does in ioredis.
    assert.deepEqual(netGrant("redis://h:6379?port=1"), { flag: "--allow-net=h:6379", open: null });
    // A repeated key is its last value, as in ioredis.
    assert.deepEqual(netGrant("redis://h?port=1&port=2"), { flag: "--allow-net=h:2", open: null });
    // ioredis strips brackets from the URL's host only; a query host is verbatim.
    assert.deepEqual(netGrant("redis://?host=[::1]&port=6391"), { flag: "--allow-net=[::1]:6391", open: null });
    // The port is read with parseInt, so a leading zero is not part of it.
    assert.deepEqual(netGrant("redis://h?port=06391"), { flag: "--allow-net=h:6391", open: null });
  });

  it("pins localhost when a URL names no host, which is where ioredis dials", () => {
    assert.deepEqual(netGrant("redis:///0"), { flag: "--allow-net=localhost:6379", open: null });
    assert.deepEqual(netGrant("redis://?port=6391"), { flag: "--allow-net=localhost:6391", open: null });
  });

  it("leaves the grant open, with a reason that never repeats the URL, when it cannot be pinned", () => {
    const cases: [string | undefined, RegExp][] = [
      [undefined, /not set/],
      ["", /not set/],
      ["  ", /not set/],
      ["/tmp/redis.sock", /unix socket path/],
      // A pathname on a scheme-less DSN is a socket path to ioredis, not a db.
      ["127.0.0.1:6391/2", /unix socket path/],
      ["redis://[::1", /not a URL this launcher can parse/],
      ["redis://hunter2:[::1", /not a URL this launcher can parse/],
      // ioredis would dial port NaN, -6391 or 70000 and fail on its own.
      ["redis://h?port=abc", /port that is not a number from 0 to 65535/],
      ["-6391", /port that is not a number from 0 to 65535/],
      ["redis://?port=70000", /port that is not a number from 0 to 65535/],
    ];
    for (const [dsn, reason] of cases) {
      const grant = netGrant(dsn);
      assert.equal(grant.flag, "--allow-net", JSON.stringify(dsn));
      assert.match(grant.open ?? "", reason, JSON.stringify(dsn));
      assert.doesNotMatch(grant.open ?? "", /hunter2|::1|redis\.sock|6391|70000/, "the reason must not echo the URL");
    }
  });

  it("grants exactly the host and port ioredis dials", () => {
    // The two sides parse REDIS_URL independently; this is what keeps them from
    // drifting. The expectation comes from a real client's resolved options --
    // its defaults and its parseInt of the port included, so a default that
    // moves is caught too -- with lazyConnect, so nothing is dialled. A grant
    // host that differs from ioredis's by one character (a bracket) is a
    // sandbox that denies every connection.
    for (const dsn of [
      "redis://[::1]:6391",
      "rediss://[2001:db8::1]",
      "redis://[::ffff:127.0.0.1]:7000",
      "redis://[0:0:0:0:0:0:0:1]:6391",
      "redis://localhost",
      "redis://:pw@10.0.0.5:6380/1",
      "REDIS://H:6391",
      "redis://h:",
      "redis://h:06391",
      "redis://127.0.0.1?port=6391",
      "redis:///2?host=cache&port=7000",
      "redis://?host=[::1]&port=6391",
      "redis://?host=a&host=b",
      "redis://h?port=1&port=2",
      "redis://h?port=06391",
      "redis:///0",
      "redis://?port=6391",
      "127.0.0.1:6379",
      ":hunter2@127.0.0.1:6379",
      "cache.internal",
      "127.0.0.1:6391\n",
      "6391",
      "6391 ",
      "6391\n",
      "+6391",
      "6391.0",
      "06391",
    ]) {
      const client = new Redis(dsn, { lazyConnect: true });
      try {
        assert.equal(client.options.path, undefined, `${JSON.stringify(dsn)} must be a TCP endpoint to ioredis`);
        assert.equal(
          netGrant(dsn).flag,
          `--allow-net=${client.options.host}:${client.options.port}`,
          JSON.stringify(dsn),
        );
      } finally {
        client.disconnect();
      }
    }
  });
});

type LauncherRun = { stdout: string; stderr: string; code: number | null };

/**
 * Run the REAL bin under Node, optionally posing as oam by preloading a
 * `process.versions.oam` key, and return what it wrote.
 *
 * The unit tests above prove the decision; these prove the launcher WIRES it
 * -- that the call site actually reads `process.versions.oam` and the sandbox
 * grant list -- which no amount of testing `runtimePlan` in isolation can. A
 * real oam cannot be assumed on every box this suite runs on, and the preload
 * changes exactly the one fact the launcher branches on.
 *
 * OAM_BIN is pinned to the Node binary running this test, which makes the two
 * outcomes unmistakable without a real oam. In-process, `--version` reaches
 * dist/index.js and prints the package version with exit 0. On the discovery
 * path, the pinned Node answers `--version` with v22.x or later, which clears
 * the floor, so it is chosen and the launcher spawns `node [flags] run <entry>`
 * -- which has no `run` subcommand, prints no version and exits non-zero. A
 * usable OAM_BIN is taken before discovery runs, so a real oam on the
 * developer's box is never reached either.
 *
 * Env is a whitelist so a REDIS_MCP_* or REDIS_URL var exported by the
 * developer's shell cannot change what is being asserted.
 *
 * `handshake` starts the server for real instead of passing `--version`: it
 * sends one MCP initialize, and closes stdin once the answer arrives, which the
 * server reads as the client going away and exits 0 on. `--version` exits on
 * its own almost at once, so it cannot show a launcher that kills a running
 * server a few milliseconds in; a handshake can. It needs REDIS_URL set, and
 * the connect is lazy, so nothing is dialled.
 */
function runLauncher(
  hostOam: string | undefined,
  extraEnv: Record<string, string> = {},
  extraPreload = "",
  handshake = false,
): Promise<LauncherRun> {
  // Every run also reports, at exit, what the LAUNCHER process's argv[1] ended
  // up as. runInProcess points it at dist/index.js; a handoff leaves it on the
  // launcher. That is the only way to tell "served in-process" from "handed
  // off to a child that printed the same version".
  const exitMarker = `import { writeSync } from "node:fs"; process.on("exit", () => { try { writeSync(2, "LAUNCHER_ARGV1=" + process.argv[1] + "\\n"); } catch {} });`;
  // And what it SPAWNED: the exact argv it hands its child, from a wrapper
  // around child_process.spawn. The launcher imports the named binding, so
  // syncBuiltinESMExports() is what makes the wrapper the one it calls. Read
  // from the launcher rather than echoed back by the child: Node 25 took
  // `--allow-net` for itself, so a child Node no longer rejects the grant as a
  // bad option and prints nothing to read.
  // Its identifiers are prefixed, and it imports what it uses itself, because
  // every preload piece, extraPreload included, is concatenated into one module.
  const spawnMarker = `import { writeSync as spawnRecorderWrite } from "node:fs"; import spawnRecorderCp from "node:child_process"; import { syncBuiltinESMExports as spawnRecorderSync } from "node:module"; const spawnRecorderReal = spawnRecorderCp.spawn; spawnRecorderCp.spawn = function (file, args, opts) { try { spawnRecorderWrite(2, "LAUNCHER_SPAWN=" + JSON.stringify(args) + String.fromCharCode(10)); } catch {} return spawnRecorderReal.call(this, file, args, opts); }; spawnRecorderSync();`;
  const posing =
    hostOam === undefined
      ? ""
      : `Object.defineProperty(process.versions, "oam", { value: ${JSON.stringify(hostOam)}, enumerable: true });`;
  const preload = [
    "--import",
    `data:text/javascript,${encodeURIComponent(`${exitMarker}${spawnMarker}${posing}${extraPreload}`)}`,
  ];
  return new Promise((resolvePromise, reject) => {
    const env = { PATH: process.env.PATH ?? "", OAM_BIN: process.execPath, ...extraEnv };
    const child = handshake
      ? spawn(process.execPath, [...preload, LAUNCHER], { env, stdio: ["pipe", "pipe", "pipe"] })
      : spawn(process.execPath, [...preload, LAUNCHER, "--version"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    if (handshake && child.stdin) {
      // A launcher that exits early closes the pipe under a pending write.
      child.stdin.on("error", () => {});
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "launcher-test", version: "0" },
          },
        })}\n`,
      );
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (handshake && /"id":1\b/.test(stdout)) child.stdin?.end();
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    // `close` rather than `exit`, so both pipes have drained before asserting.
    child.on("close", (code) => resolvePromise({ stdout, stderr, code }));
  });
}

// The in-process path imports dist/index.js, so the suites below need the
// esbuild bundle. `npm test` always builds first; skip rather than fail when
// someone runs a compiled test file directly against a tree without one.
const skip = existsSync(DIST_BIN) ? false : "dist/index.js is not built";
// Each case boots one to three Node processes, which is seconds apiece on a
// contended Windows box.
const timeout = 45_000;

const servedInProcess = (run: LauncherRun) => run.code === 0 && run.stdout.trim() === PACKAGE_VERSION;

describe("launcher on an oam host", () => {
  it("control: on plain Node the launcher still discovers and spawns", { skip, timeout }, async () => {
    // Without this, the in-process cases below would also pass for a launcher
    // that ALWAYS runs in-process and never uses oam at all.
    const run = await runLauncher(undefined);
    assert.equal(servedInProcess(run), false, `expected a spawn, got ${JSON.stringify(run)}`);
    assert.notEqual(run.code, 0);
  });

  it("serves in-process instead of spawning a nested oam", { skip, timeout }, async () => {
    const envs: Record<string, string>[] = [{}, { REDIS_MCP_RUNTIME: "oam" }];
    for (const extraEnv of envs) {
      const run = await runLauncher("0.15.2", extraEnv);
      assert.equal(servedInProcess(run), true, `${JSON.stringify(extraEnv)} -> ${JSON.stringify(run)}`);
      assert.match(run.stderr, /LAUNCHER_ARGV1=.*dist[\\/]index\.js/);
    }
  });

  it("still spawns under REDIS_MCP_SANDBOX=1, so --permission is not dropped", { skip, timeout }, async () => {
    // With a REDIS_URL too, so the spawn would carry the derived, pinned net
    // grant -- the part of the sandbox this server's launcher adds.
    const run = await runLauncher("0.15.2", { REDIS_MCP_SANDBOX: "1", REDIS_URL: "redis://127.0.0.1:1" });
    assert.equal(servedInProcess(run), false, `the sandbox must force a spawn, got ${JSON.stringify(run)}`);
    assert.notEqual(run.code, 0);
    // A spawned child failing, not the launcher diagnosing: every launcher
    // message starts with `redis-mcp: `.
    assert.doesNotMatch(run.stderr, /^redis-mcp: /m);
  });

  it("still discovers when the host oam is below the floor", { skip, timeout }, async () => {
    const run = await runLauncher("0.15.1");
    assert.equal(servedInProcess(run), false, `a below-floor host must not shortcut, got ${JSON.stringify(run)}`);
    assert.notEqual(run.code, 0);
    assert.doesNotMatch(run.stderr, /^redis-mcp: /m);
  });
});

describe("launcher sandbox grant, as passed to the spawned oam", () => {
  /**
   * The argv the launcher handed its child, recorded by runLauncher's spawn
   * wrapper: the wiring, not just netGrant in isolation. With OAM_BIN pinned to
   * Node the child is Node, which cannot run oam's flags -- that does not
   * matter, the argv is captured before it starts.
   */
  const spawnedArgv = (stderr: string): string[] => {
    const line = /^LAUNCHER_SPAWN=(.*?)\r?$/m.exec(stderr)?.[1];
    assert.ok(
      line,
      "no LAUNCHER_SPAWN line: the launcher spawned nothing, or spawned through a path runLauncher's recorder does not wrap (it wraps child_process.spawn only)",
    );
    return JSON.parse(line) as string[];
  };
  /**
   * The one net grant in the process-level flags. Exactly one: oam applies the
   * LAST `--allow-net` it sees, so a second, bare one appended by a regression
   * would open the network while the first still read as pinned.
   */
  const passedGrant = (stderr: string) => {
    const argv = spawnedArgv(stderr);
    const flags = argv.filter((arg) => arg.startsWith("--allow-net"));
    assert.equal(flags.length, 1, `exactly one --allow-net, oam applies the last one: ${JSON.stringify(argv)}`);
    return flags[0];
  };

  it("passes an IPv6 grant without brackets, in the process-level flags before `run`", { skip, timeout }, async () => {
    const run = await runLauncher(undefined, { REDIS_MCP_SANDBOX: "1", REDIS_URL: "redis://[::1]:6391" });
    assert.equal(passedGrant(run.stderr), "--allow-net=::1:6391", JSON.stringify(run));
    assert.doesNotMatch(run.stderr, /^redis-mcp: /m, "a pinned grant needs no note");
    // The whole prefix oam reads before `run`: nothing missing, nothing extra.
    const argv = spawnedArgv(run.stderr);
    const prefix = argv.slice(0, argv.indexOf("run"));
    assert.equal(prefix.length, 3, JSON.stringify(argv));
    assert.equal(prefix[0], "--permission");
    assert.equal(prefix[1], "--allow-net=::1:6391");
    assert.match(prefix[2] ?? "", /^--allow-env=.*\bREDIS_URL\b/);
  });

  it("pins a scheme-less REDIS_URL the way ioredis reads it, instead of opening the grant", {
    skip,
    timeout,
  }, async () => {
    const run = await runLauncher(undefined, { REDIS_MCP_SANDBOX: "1", REDIS_URL: ":hunter2@127.0.0.1:6379" });
    assert.equal(passedGrant(run.stderr), "--allow-net=127.0.0.1:6379", JSON.stringify(run));
    assert.doesNotMatch(run.stderr, /^redis-mcp: /m, "a pinned grant needs no note");
  });

  it("says so on stderr when the grant has to stay open, without echoing REDIS_URL", { skip, timeout }, async () => {
    // An unterminated IPv6 literal: WHATWG rejects it, and so does ioredis.
    const run = await runLauncher(undefined, { REDIS_MCP_SANDBOX: "1", REDIS_URL: "redis://:hunter2@[::1" });
    assert.equal(passedGrant(run.stderr), "--allow-net", JSON.stringify(run));
    assert.match(
      run.stderr,
      /^redis-mcp: REDIS_MCP_SANDBOX=1, but REDIS_URL is not a URL this launcher can parse, so the sandbox cannot pin its network grant to the Redis endpoint and leaves network access open\.\r?$/m,
    );
    assert.doesNotMatch(run.stderr, /hunter2/, "REDIS_URL can carry a password; it must never reach stderr");
  });

  it("stays quiet about an open grant when REDIS_URL is unset or blank, which the server reports itself", {
    skip,
    timeout,
  }, async () => {
    const envs: Record<string, string>[] = [{ REDIS_MCP_SANDBOX: "1" }, { REDIS_MCP_SANDBOX: "1", REDIS_URL: "  " }];
    for (const extraEnv of envs) {
      const run = await runLauncher(undefined, extraEnv);
      assert.equal(passedGrant(run.stderr), "--allow-net", JSON.stringify(run));
      assert.doesNotMatch(run.stderr, /^redis-mcp: /m, JSON.stringify(extraEnv));
    }
  });
});

describe("launcher with no usable oam", () => {
  /**
   * An environment with no oam anywhere: HOME and LOCALAPPDATA point at an
   * empty directory, so the installed locations are empty, and PATH holds only
   * the directory of the Node running this test. Keeps a real oam on the
   * developer's box out of reach.
   */
  function isolated(extra: Record<string, string> = {}): Record<string, string> {
    const empty = mkdtempSync(join(tmpdir(), "redis-mcp-launcher-home-"));
    return {
      PATH: dirname(process.execPath),
      USERPROFILE: empty,
      HOME: empty,
      LOCALAPPDATA: empty,
      OAM_BIN: join(tmpdir(), "no-such-dir", "oam.exe"),
      ...extra,
    };
  }

  it("names an OAM_BIN that does not exist instead of falling back silently", { skip, timeout }, async () => {
    const run = await runLauncher(undefined, isolated());
    assert.equal(run.code, 0, JSON.stringify(run));
    assert.equal(run.stdout.trim(), PACKAGE_VERSION);
    assert.match(run.stderr, /^redis-mcp: OAM_BIN=.*does not exist; using Node instead\.$/m);
  });

  it("hands a below-floor oam host off to Node rather than serving on it", { skip, timeout }, async () => {
    const run = await runLauncher("0.9.0", isolated());
    assert.equal(run.code, 0, JSON.stringify(run));
    assert.equal(run.stdout.trim(), PACKAGE_VERSION, "the Node child must still serve");
    assert.match(
      run.stderr,
      /this process is oam 0\.9\.0, older than 0\.15\.2, and no newer oam was found; running on .*node/,
    );
    // Served by the child, not in the launcher process: argv[1] was never
    // pointed at dist/index.js.
    assert.match(run.stderr, /LAUNCHER_ARGV1=.*redis-mcp\.mjs/);
  });

  it("refuses to serve on a below-floor oam host when there is no Node either", { skip, timeout }, async () => {
    const noNode = mkdtempSync(join(tmpdir(), "redis-mcp-launcher-nopath-"));
    const run = await runLauncher("0.9.0", isolated({ PATH: noNode, OAM_BIN: join(noNode, "oam.exe") }));
    assert.equal(run.code, 1, JSON.stringify(run));
    assert.equal(run.stdout.trim(), "", "nothing may be served");
    assert.match(run.stderr, /no Node was found on PATH/);
  });

  it("hands REDIS_MCP_RUNTIME=node off to Node even on a supported oam host", { skip, timeout }, async () => {
    const run = await runLauncher("0.15.2", isolated({ REDIS_MCP_RUNTIME: "node" }));
    assert.equal(run.code, 0, JSON.stringify(run));
    assert.equal(run.stdout.trim(), PACKAGE_VERSION);
    assert.match(run.stderr, /LAUNCHER_ARGV1=.*redis-mcp\.mjs/);
  });

  it("falls back in-process on a supported oam host under REDIS_MCP_SANDBOX=1 and auto", {
    skip,
    timeout,
  }, async () => {
    // The documented, unsandboxed fallback: a supported host oam may serve the
    // server itself, so with nothing to spawn it does -- without --permission,
    // and the note says so rather than claiming Node.
    const run = await runLauncher("0.15.2", isolated({ REDIS_MCP_SANDBOX: "1", REDIS_URL: "redis://127.0.0.1:1" }));
    assert.equal(servedInProcess(run), true, JSON.stringify(run));
    assert.match(run.stderr, /LAUNCHER_ARGV1=.*dist[\\/]index\.js/);
    assert.match(run.stderr, /does not exist; serving in-process on this oam 0\.15\.2, without --permission\.$/m);
  });

  it("exits instead under REDIS_MCP_SANDBOX=1 with REDIS_MCP_RUNTIME=oam", { skip, timeout }, async () => {
    const run = await runLauncher(
      "0.15.2",
      isolated({ REDIS_MCP_SANDBOX: "1", REDIS_MCP_RUNTIME: "oam", REDIS_URL: "redis://127.0.0.1:1" }),
    );
    assert.equal(run.code, 1, JSON.stringify(run));
    assert.equal(run.stdout.trim(), "", "nothing may be served unsandboxed");
    assert.match(run.stderr, /REDIS_MCP_RUNTIME=oam but no usable oam \(0\.15\.2 or newer\) was found/);
  });

  /**
   * A preload that makes the launcher's FIRST spawn target a path that does not
   * exist; later spawns (the Node fallback) are untouched. It stands in for a
   * chosen oam that passed its --version probe and then could not be spawned --
   * deleted or replaced in between.
   */
  const failFirstSpawn = [
    'import childProcess from "node:child_process";',
    'import { syncBuiltinESMExports } from "node:module";',
    "const realSpawn = childProcess.spawn;",
    "let failed = false;",
    "childProcess.spawn = function (cmd, args, opts) {",
    "  if (failed) return realSpawn.call(this, cmd, args, opts);",
    "  failed = true;",
    '  return realSpawn.call(this, cmd + ".does-not-exist", args, opts);',
    "};",
    "syncBuiltinESMExports();",
  ].join("\n");

  it("still falls back when the chosen oam fails to spawn on an oam host", { skip, timeout }, async () => {
    // A failed spawn emits 'error' and then 'close' with the negative errno, and
    // on an oam host the launcher pipes stdio and waits for 'close' -- so an
    // unguarded close handler exited the launcher mid-fallback and nothing
    // served.
    const run = await runLauncher("0.9.0", isolated({ OAM_BIN: process.execPath }), failFirstSpawn);
    assert.equal(run.code, 0, JSON.stringify(run));
    assert.equal(run.stdout.trim(), PACKAGE_VERSION, "the Node fallback must still serve");
    assert.match(run.stderr, /failed to launch oam at .*using Node instead/);
    assert.match(run.stderr, /LAUNCHER_ARGV1=.*redis-mcp\.mjs/);
  });

  it("still serves in-process when the sandboxed oam fails to spawn on a supported oam host", {
    skip,
    timeout,
  }, async () => {
    // The same failure on this launcher's other oam-host fallback: a supported
    // host that took the discovery path for REDIS_MCP_SANDBOX=1 falls back into
    // its own process, and the same close handler cut that short. A handshake,
    // not --version: the server's --version exits before that close event
    // fires, so it passed with the bug present.
    const run = await runLauncher(
      "0.15.2",
      isolated({ OAM_BIN: process.execPath, REDIS_MCP_SANDBOX: "1", REDIS_URL: "redis://127.0.0.1:1" }),
      failFirstSpawn,
      true,
    );
    assert.equal(run.code, 0, JSON.stringify(run));
    assert.match(run.stdout, /"id":1\b.*"result"|"result".*"id":1\b/, "the in-process server must answer initialize");
    assert.match(run.stderr, /LAUNCHER_ARGV1=.*dist[\\/]index\.js/);
    assert.match(
      run.stderr,
      /failed to launch oam at .*; serving in-process on this oam 0\.15\.2, without --permission\.$/m,
    );
  });
});
