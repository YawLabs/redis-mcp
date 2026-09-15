import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { getClient, runCommand, shutdown } from "./api.js";
import { startTlsRespServer, type TlsRespServer } from "./tls-fixture.js";

// Resolve via import.meta.url so this works regardless of process.cwd(); the
// compiled file lives in dist/, one level below the repo root.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = resolve(REPO_ROOT, "bin", "redis-mcp.mjs");
const DIST_BIN = resolve(REPO_ROOT, "dist", "index.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PONG = JSON.stringify("PONG");
/** What the server logs when the handshake rejects the fixture's certificate. */
const UNTRUSTED = /client error: self-signed certificate/;
/** What ioredis reports when the connect timeout fires before the handshake completes. */
const STALLED = /connect ETIMEDOUT/;
/**
 * What ioredis reports when the command timeout fires first. The stalled cases
 * set it BELOW ioredis's own 10s connect-timeout default, so a server that
 * stopped passing REDIS_CONNECT_TIMEOUT_MS on shows up as this instead of as a
 * slower STALLED.
 */
const COMMAND_TIMED_OUT = /Command timed out/;

/**
 * A TCP server that accepts and never writes a byte, so a TLS client's
 * handshake stalls until its own connect timeout gives up.
 */
async function startStalledServer(): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((done) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => done());
      }),
  };
}

/** Run `fn` with console.error captured, and return what it logged. */
async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return { result: await fn(), stderr: lines.join("\n") };
  } finally {
    console.error = original;
  }
}

/**
 * The server's own client over rediss://, in this process. No oam needed, so
 * this runs on every box: it pins api.ts's TLS wiring (the `tls` option from
 * REDIS_TLS_REJECT_UNAUTHORIZED, the connect timeout) end to end against a real
 * TLS server.
 */
describe("the server's client over rediss://", () => {
  let server: TlsRespServer;
  const KEYS = ["REDIS_URL", "REDIS_TLS_REJECT_UNAUTHORIZED", "REDIS_CONNECT_TIMEOUT_MS", "REDIS_COMMAND_TIMEOUT_MS"];
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  before(async () => {
    server = await startTlsRespServer();
  });
  after(async () => {
    await shutdown();
    await server.close();
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  /** A fresh client on the next call, built from `env`. */
  async function configure(env: Record<string, string | undefined>) {
    await shutdown();
    for (const key of KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
  }

  it("answers PING, and reconnects over a new connection after the server drops it", async () => {
    await configure({ REDIS_URL: `rediss://127.0.0.1:${server.port}`, REDIS_TLS_REJECT_UNAUTHORIZED: "false" });
    // ioredis sends INFO once per connection, as its ready check, so a second
    // INFO is a second connection: the proof that the reconnect happened.
    const readyChecks = () => server.received.filter((command) => command[0]?.toUpperCase() === "INFO").length;
    assert.deepEqual(await runCommand("PING", []), { ok: true, data: "PONG" });
    const before = readyChecks();
    assert.ok(before >= 1, "the first connection must have run its ready check");
    await server.dropConnections();
    await sleep(300);
    assert.deepEqual(
      await runCommand("PING", []),
      { ok: true, data: "PONG" },
      "a dropped idle connection must reconnect",
    );
    assert.equal(readyChecks(), before + 1, "the second PING must have gone over a new connection");
    assert.ok(getClient().options.tls, "rediss:// must have turned TLS on");
  });

  it("refuses the fixture's self-signed certificate when verification is on", async () => {
    // The control for the NODE_EXTRA_CA_CERTS cases below: without a trusted CA
    // the handshake must fail -- for the certificate, not for any other reason.
    await configure({ REDIS_URL: `rediss://127.0.0.1:${server.port}` });
    const { result, stderr } = await captureStderr(() => runCommand("PING", []));
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.match(stderr, UNTRUSTED);
  });

  it("gives up on a stalled TLS handshake at the connect timeout, not the command timeout", async () => {
    const stalled = await startStalledServer();
    try {
      await configure({
        REDIS_URL: `rediss://127.0.0.1:${stalled.port}`,
        REDIS_TLS_REJECT_UNAUTHORIZED: "false",
        REDIS_CONNECT_TIMEOUT_MS: "500",
        REDIS_COMMAND_TIMEOUT_MS: "5000",
      });
      const started = Date.now();
      const { result, stderr } = await captureStderr(() => runCommand("PING", []));
      const elapsed = Date.now() - started;
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.match(stderr, STALLED);
      assert.doesNotMatch(`${JSON.stringify(result)}\n${stderr}`, COMMAND_TIMED_OUT);
      assert.ok(elapsed < 4_500, `gave up after ${elapsed}ms; the 5s command timeout must not be what ended it`);
    } finally {
      await shutdown();
      await stalled.close();
    }
  });
});

/* ---------- end to end, through the launcher ---------- */

/** The launcher's floor, read from its source so the two cannot disagree. */
function launcherFloor(): number[] {
  const match = readFileSync(LAUNCHER, "utf-8").match(/const OAM_MIN = \[([^\]]*)\];/);
  if (!match) throw new Error("could not extract OAM_MIN from bin/redis-mcp.mjs -- renamed or reformatted?");
  return match[1]!.split(",").map((n) => Number(n.trim()));
}

const atLeast = (v: number[], min: number[]) => {
  for (let i = 0; i < min.length; i++) {
    if ((v[i] ?? 0) !== (min[i] ?? 0)) return (v[i] ?? 0) > (min[i] ?? 0);
  }
  return true;
};

/** Where `command` resolves on PATH, for naming the binary a run tested; itself when it is a path. */
function resolveOnPath(command: string): string {
  if (/[\\/]/.test(command)) return command;
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [command], { encoding: "utf8" });
  return probe.status === 0 ? (probe.stdout.split(/\r?\n/)[0] ?? command) : command;
}

/**
 * The newest oam this box can run at or above the launcher's floor: OAM_BIN,
 * `oam` on PATH, then the default install locations, each asked for its
 * version with the launcher's own 5s budget. Discovery here is deliberately
 * its own few lines rather than the launcher's: the launcher's discovery is
 * what the cases below exercise. On a version tie the earlier candidate wins,
 * as in the launcher, so OAM_BIN pins the binary under test. The skip reason
 * names every candidate that answered, and every one that was present but
 * would not, so "no oam" and "an oam that is broken" read differently.
 */
function findOam(): { path: string; version: string; resolved: string } | { skip: string } {
  const exe = process.platform === "win32" ? "oam.exe" : "oam";
  const candidates = [
    process.env.OAM_BIN,
    "oam",
    process.platform === "win32"
      ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "oam", "bin", exe)
      : undefined,
    join(homedir(), ".oam", "bin", exe),
  ].filter((c): c is string => typeof c === "string" && c.length > 0);
  let best: { path: string; version: number[]; text: string } | null = null;
  const seen: string[] = [];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 5_000, windowsHide: true });
    const errorCode = (probe.error as NodeJS.ErrnoException | undefined)?.code;
    if (errorCode === "ENOENT") continue; // not there at all
    const match = probe.status === 0 ? /(\d+)\.(\d+)\.(\d+)/.exec(probe.stdout) : null;
    if (!match) {
      const why = errorCode ?? (probe.signal ? `killed by ${probe.signal}` : `exit ${probe.status}`);
      seen.push(`${candidate} (${why})`);
      continue;
    }
    const version = [Number(match[1]), Number(match[2]), Number(match[3])];
    seen.push(`${candidate} (${match[0]})`);
    const newer = !best || (atLeast(version, best.version) && version.join(".") !== best.version.join("."));
    if (newer) best = { path: candidate, version, text: match[0] };
  }
  const floor = launcherFloor();
  if (best && atLeast(best.version, floor))
    return { path: best.path, version: best.text, resolved: resolveOnPath(best.path) };
  return {
    skip: `no oam at or above the launcher floor ${floor.join(".")} was found${seen.length ? ` (saw ${seen.join(", ")})` : ""}`,
  };
}

/**
 * Run `command` to completion and collect what it wrote. The child is killed
 * if the test's abort signal fires, so a child that never exits turns into a
 * red test with its output attached rather than a `node --test` that never
 * finishes.
 */
function collect(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  drive?: (child: ChildProcess, onLine: (listener: (line: string) => void) => void) => void,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolvePromise, reject) => {
    const child: ChildProcess = spawn(command, args, {
      cwd: REPO_ROOT,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const onAbort = () => child.kill();
    signal.addEventListener("abort", onAbort, { once: true });
    let stdout = "";
    let stderr = "";
    let pending = "";
    const lineListeners: ((line: string) => void)[] = [];
    child.stdin?.on("error", () => {});
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) for (const listener of lineListeners) listener(line);
    });
    child.on("error", reject);
    // `close` rather than `exit`, so both pipes have drained before asserting.
    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      resolvePromise({ stdout, stderr, code });
    });
    drive?.(child, (listener) => lineListeners.push(listener));
  });
}

interface McpRun {
  /** Each tool call's result text (or its JSON-RPC error), in call order. */
  results: string[];
  stderr: string;
  code: number | null;
}

/**
 * Start `command` as an MCP server, complete the handshake, call
 * `redis_command PING` `calls` times (running `between` before the second and
 * later ones), and close stdin once the last answer is in; the server reads
 * that as the client going away and exits on its own.
 */
async function mcpPing(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  calls = 1,
  between?: () => Promise<void>,
): Promise<McpRun> {
  const results: string[] = [];
  const run = await collect(command, args, env, signal, (child, onLine) => {
    const send = (message: unknown) => child.stdin?.write(`${JSON.stringify(message)}\n`);
    const ping = (id: number) =>
      send({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "redis_command", arguments: { command: "PING" } },
      });
    onLine((line) => {
      let message: { id?: number; result?: { content?: { text?: string }[] }; error?: unknown };
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id === 1) {
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        ping(2);
      } else if (typeof message.id === "number" && message.id >= 2) {
        const id = message.id;
        results.push(message.result?.content?.[0]?.text ?? JSON.stringify(message.error));
        if (results.length >= calls) child.stdin?.end();
        else if (between) between().then(() => ping(id + 1));
        else ping(id + 1);
      }
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "tls-oam-test", version: "0" },
      },
    });
  });
  return { results, stderr: run.stderr, code: run.code };
}

/**
 * The environment every launcher case starts from. The developer's shell must
 * not be able to change what is asserted: drop every REDIS_* and OAM_*
 * variable, NODE_OPTIONS (which could preload into the Node side),
 * NODE_EXTRA_CA_CERTS (which would trust the fixture where a case means not
 * to) and NODE_TLS_REJECT_UNAUTHORIZED (which would turn verification off
 * underneath every case), then set exactly what each case needs.
 */
function cleanEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^(REDIS_|OAM_|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$|NODE_TLS_REJECT_UNAUTHORIZED$)/i.test(key),
      ),
    ),
    ...extra,
  };
}

// Each case boots a runtime, and some boot two, which is seconds apiece on a
// contended Windows box.
const timeout = 45_000;
const built = existsSync(DIST_BIN) ? false : "dist/index.js is not built";

describe("rediss:// on Node, through the launcher", { skip: built }, () => {
  let server: TlsRespServer;
  let caDir: string;
  before(async () => {
    server = await startTlsRespServer();
    caDir = mkdtempSync(join(tmpdir(), "redis-mcp-ca-"));
    writeFileSync(join(caDir, "ca.pem"), server.cert);
  });
  after(async () => {
    await server.close();
    rmSync(caDir, { recursive: true, force: true });
  });

  it("verifies a private CA named only by NODE_EXTRA_CA_CERTS", { timeout }, async (t) => {
    // REDIS_TLS_REJECT_UNAUTHORIZED is unset, so certificate verification is
    // on; the fixture's certificate is trusted through the variable alone.
    const run = await mcpPing(
      process.execPath,
      [LAUNCHER],
      cleanEnv({
        REDIS_URL: `rediss://127.0.0.1:${server.port}`,
        REDIS_MCP_RUNTIME: "node",
        NODE_EXTRA_CA_CERTS: join(caDir, "ca.pem"),
      }),
      t.signal,
    );
    assert.deepEqual(run.results, [PONG], JSON.stringify(run));
    assert.match(run.stderr, /ready \(.*\) on node /);
    assert.equal(run.code, 0);
    // Control: the same launch without the CA must fail on the certificate, or
    // the pass above could come from a path that does not verify at all.
    const control = await mcpPing(
      process.execPath,
      [LAUNCHER],
      cleanEnv({ REDIS_URL: `rediss://127.0.0.1:${server.port}`, REDIS_MCP_RUNTIME: "node" }),
      t.signal,
    );
    assert.equal(control.results.length, 1, JSON.stringify(control));
    assert.notDeepEqual(control.results, [PONG], JSON.stringify(control));
    assert.match(control.stderr, UNTRUSTED, JSON.stringify(control));
  });

  it("gives a host that runs dist/index.js directly on an old oam an error to act on, not a crash", {
    timeout,
  }, async (t) => {
    // That host skips the launcher and its version floor. On oam 0.15.2 a TLS
    // connection used to kill the process on the first tool call; the server now
    // refuses it before dialling. Node posing as oam 0.15.2 stands in for it --
    // the refusal reads `process.versions.oam` and nothing else.
    const posing = `Object.defineProperty(process.versions, "oam", { value: "0.15.2", enumerable: true });`;
    const receivedBefore = server.received.length;
    const run = await mcpPing(
      process.execPath,
      ["--import", `data:text/javascript,${encodeURIComponent(posing)}`, DIST_BIN],
      cleanEnv({ REDIS_URL: `rediss://127.0.0.1:${server.port}`, REDIS_TLS_REJECT_UNAUTHORIZED: "false" }),
      t.signal,
    );
    assert.equal(run.code, 0, `the server must keep running: ${JSON.stringify(run)}`);
    assert.equal(run.results.length, 1, JSON.stringify(run));
    assert.match(
      run.results[0] ?? "",
      /^Error: TLS \(rediss:\/\/\) needs oam 0\.15\.3 or newer, and this server is running on oam 0\.15\.2/,
    );
    assert.match(run.stderr, /ready \(.*\) on oam 0\.15\.2/);
    assert.match(
      run.stderr,
      /^@yawlabs\/redis-mcp: TLS \(rediss:\/\/\) needs oam 0\.15\.3 or newer/m,
      "said at startup too",
    );
    assert.equal(server.received.length, receivedBefore, "nothing may have been dialled");
  });
});

const oam = findOam();
const skip = built || ("skip" in oam ? oam.skip : false);

describe(`rediss:// under a real oam${"path" in oam ? ` (${oam.version} at ${oam.resolved})` : ""}`, { skip }, () => {
  let server: TlsRespServer;
  let env: NodeJS.ProcessEnv;
  let caDir: string;
  const oamPath = "path" in oam ? oam.path : "";
  /** The same oam as an absolute path, for a run whose PATH no longer finds it by name. */
  const oamResolved = "resolved" in oam ? oam.resolved : "";
  const oamVersion = "version" in oam ? oam.version : "";
  /** The banner the server prints when oam, not a Node fallback, is serving. */
  const servedByOam = new RegExp(`ready \\(.*\\) on oam ${oamVersion.replace(/\./g, "\\.")}`);

  before(async () => {
    server = await startTlsRespServer();
    env = cleanEnv({ REDIS_URL: `rediss://127.0.0.1:${server.port}`, REDIS_TLS_REJECT_UNAUTHORIZED: "false" });
    caDir = mkdtempSync(join(tmpdir(), "redis-mcp-ca-"));
    writeFileSync(join(caDir, "ca.pem"), server.cert);
  });
  after(async () => {
    await server.close();
    rmSync(caDir, { recursive: true, force: true });
  });

  it("answers PING when the host runs the launcher under `oam run` (served in-process)", { timeout }, async (t) => {
    const run = await mcpPing(oamPath, ["run", LAUNCHER], env, t.signal);
    assert.deepEqual(run.results, [PONG], JSON.stringify(run));
    assert.match(run.stderr, servedByOam);
    assert.equal(run.code, 0);
  });

  it("answers PING when the launcher, in its default auto mode, discovers that oam and spawns it", {
    timeout,
  }, async (t) => {
    // REDIS_MCP_RUNTIME is unset, so this is the configuration every user gets
    // by default. `auto` may fall back to Node, which would also answer PONG;
    // the banner match is what rules that out.
    const run = await mcpPing(process.execPath, [LAUNCHER], { ...env, OAM_BIN: oamPath }, t.signal);
    assert.deepEqual(run.results, [PONG], JSON.stringify(run));
    assert.match(run.stderr, servedByOam, `oam must have served, not a Node fallback: ${JSON.stringify(run)}`);
    assert.equal(run.code, 0);
  });

  it("answers PING inside the sandbox, whose net grant is the rediss:// host and port", { timeout }, async (t) => {
    // REDIS_MCP_RUNTIME=oam here: under `auto` a fallback runs unsandboxed,
    // and this case is about --permission being in force.
    const run = await mcpPing(
      process.execPath,
      [LAUNCHER],
      { ...env, OAM_BIN: oamPath, REDIS_MCP_RUNTIME: "oam", REDIS_MCP_SANDBOX: "1" },
      t.signal,
    );
    assert.deepEqual(run.results, [PONG], JSON.stringify(run));
    assert.match(run.stderr, servedByOam);
    assert.equal(run.code, 0);
  });

  it("applies the sandbox under `oam run` by relaunching that same oam, when no other oam can be found", {
    timeout,
  }, async (t) => {
    // A host that bundles its own oam launches the bin with it, and that binary
    // is in no install dir and not on PATH. REDIS_MCP_SANDBOX=1 used to find no
    // oam to spawn there and serve in-process, unsandboxed, with a note saying
    // no oam was found while running on one. HOME, USERPROFILE and LOCALAPPDATA
    // point at an empty directory and PATH holds only Node's, so the host's own
    // binary is the only oam in reach.
    const empty = mkdtempSync(join(tmpdir(), "redis-mcp-no-oam-"));
    try {
      const run = await mcpPing(
        oamResolved,
        ["run", LAUNCHER],
        {
          ...env,
          PATH: dirname(process.execPath),
          HOME: empty,
          USERPROFILE: empty,
          LOCALAPPDATA: empty,
          REDIS_MCP_SANDBOX: "1",
        },
        t.signal,
      );
      assert.deepEqual(run.results, [PONG], JSON.stringify(run));
      assert.match(run.stderr, servedByOam);
      // The fallback this replaced still answers PONG on oam; its note is what
      // tells them apart.
      assert.doesNotMatch(run.stderr, /^redis-mcp: /m, `a relaunch is not a fallback: ${JSON.stringify(run)}`);
      assert.equal(run.code, 0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("answers PING inside the sandbox for an IPv6 literal REDIS_URL", { timeout }, async (t) => {
    // #14: the launcher used to grant `--allow-net=[::1]:<port>`, which oam
    // never matches (it checks `::1:<port>`), so every tool call inside the
    // sandbox came back "Access to this API has been restricted".
    let v6: TlsRespServer;
    try {
      v6 = await startTlsRespServer("::1");
    } catch (err) {
      t.skip(`cannot listen on ::1 here (${(err as NodeJS.ErrnoException).code ?? err})`);
      return;
    }
    try {
      const run = await mcpPing(
        process.execPath,
        [LAUNCHER],
        {
          ...env,
          REDIS_URL: `rediss://[::1]:${v6.port}`,
          OAM_BIN: oamPath,
          REDIS_MCP_RUNTIME: "oam",
          REDIS_MCP_SANDBOX: "1",
        },
        t.signal,
      );
      assert.deepEqual(run.results, [PONG], JSON.stringify(run));
      assert.match(run.stderr, servedByOam);
      assert.doesNotMatch(run.stderr, /restricted|ERR_ACCESS_DENIED/);
      assert.equal(run.code, 0);
    } finally {
      await v6.close();
    }
  });

  it("reconnects after the server drops the connection, instead of timing out forever", { timeout }, async (t) => {
    // A managed Redis ends idle connections. Before 0.15.3, oam's TLS socket
    // emitted `end` and then nothing, so ioredis never saw the `close` it
    // reconnects on, stayed `ready`, and every later command timed out.
    // ioredis runs INFO once per connection as its ready check, so the count
    // across the drop proves the second PING went over a new connection.
    const readyChecks = () => server.received.filter((command) => command[0]?.toUpperCase() === "INFO").length;
    let beforeDrop = 0;
    const run = await mcpPing(oamPath, ["run", LAUNCHER], env, t.signal, 2, async () => {
      beforeDrop = readyChecks();
      await server.dropConnections();
      // The client's `end` arrives one loopback packet later; a short pause
      // keeps the second PING from racing the drop it is meant to survive.
      await sleep(250);
    });
    assert.deepEqual(run.results, [PONG, PONG], JSON.stringify(run));
    assert.match(run.stderr, servedByOam);
    assert.equal(run.code, 0);
    assert.equal(readyChecks(), beforeDrop + 1, "the second PING must have gone over a new connection");
  });

  it("verifies a private CA named only by NODE_EXTRA_CA_CERTS, sandbox included", { timeout }, async (t) => {
    // Verification on (REDIS_TLS_REJECT_UNAUTHORIZED unset), the fixture's
    // certificate trusted through the variable alone. oam reads it before the
    // sandbox applies, so --allow-env need not list it.
    const trusted = cleanEnv({
      REDIS_URL: `rediss://127.0.0.1:${server.port}`,
      NODE_EXTRA_CA_CERTS: join(caDir, "ca.pem"),
    });
    const paths = [
      ["oam run", oamPath, ["run", LAUNCHER], {}],
      [
        "sandboxed",
        process.execPath,
        [LAUNCHER],
        { OAM_BIN: oamPath, REDIS_MCP_RUNTIME: "oam", REDIS_MCP_SANDBOX: "1" },
      ],
    ] as const;
    for (const [label, command, args, extra] of paths) {
      const run = await mcpPing(command, [...args], { ...trusted, ...extra }, t.signal);
      assert.deepEqual(run.results, [PONG], `${label}: ${JSON.stringify(run)}`);
      assert.match(run.stderr, servedByOam, label);
      assert.equal(run.code, 0, label);
      // Control, on the same path: without the CA it must fail on the
      // certificate, or the pass above could come from a path that does not
      // verify at all.
      const untrusted = cleanEnv({ REDIS_URL: `rediss://127.0.0.1:${server.port}`, ...extra });
      const control = await mcpPing(command, [...args], untrusted, t.signal);
      assert.equal(control.results.length, 1, `${label} control: ${JSON.stringify(control)}`);
      assert.notDeepEqual(control.results, [PONG], `${label} control: ${JSON.stringify(control)}`);
      assert.match(control.stderr, UNTRUSTED, `${label} control: ${JSON.stringify(control)}`);
      assert.match(control.stderr, servedByOam, `${label} control`);
    }
  });

  it("gives up on a stalled TLS handshake at the connect timeout, not the command timeout", { timeout }, async (t) => {
    // ioredis arms its connect timeout only while the socket reports
    // `connecting` and has `setTimeout` -- two of the members oam's TLS socket
    // lacked before 0.15.3. Without them a handshake that never completes waits
    // out the command timeout instead. No elapsed-time bound: it would have to
    // absorb oam's startup on a contended box, and COMMAND_TIMED_OUT already
    // tells the two timeouts apart.
    const stalled = await startStalledServer();
    try {
      const run = await mcpPing(
        oamPath,
        ["run", LAUNCHER],
        {
          ...env,
          REDIS_URL: `rediss://127.0.0.1:${stalled.port}`,
          REDIS_CONNECT_TIMEOUT_MS: "500",
          REDIS_COMMAND_TIMEOUT_MS: "5000",
        },
        t.signal,
      );
      assert.equal(run.results.length, 1, JSON.stringify(run));
      assert.notDeepEqual(run.results, [PONG], JSON.stringify(run));
      assert.match(run.stderr, STALLED, JSON.stringify(run));
      assert.doesNotMatch(`${run.results.join("\n")}\n${run.stderr}`, COMMAND_TIMED_OUT, JSON.stringify(run));
      assert.match(run.stderr, servedByOam);
    } finally {
      await stalled.close();
    }
  });
});
