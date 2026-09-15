import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * The server's own client over rediss://, in this process. No oam needed, so
 * this runs on every box: it pins api.ts's TLS wiring (the `tls` option from
 * REDIS_TLS_REJECT_UNAUTHORIZED) end to end against a real TLS server.
 */
describe("the server's client over rediss://", () => {
  let server: TlsRespServer;
  const saved = { url: process.env.REDIS_URL, reject: process.env.REDIS_TLS_REJECT_UNAUTHORIZED };
  before(async () => {
    server = await startTlsRespServer();
  });
  after(async () => {
    await shutdown();
    await server.close();
    if (saved.url === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = saved.url;
    if (saved.reject === undefined) delete process.env.REDIS_TLS_REJECT_UNAUTHORIZED;
    else process.env.REDIS_TLS_REJECT_UNAUTHORIZED = saved.reject;
  });

  it("answers PING, and reconnects after the server drops the connection", async () => {
    await shutdown();
    process.env.REDIS_URL = `rediss://127.0.0.1:${server.port}`;
    process.env.REDIS_TLS_REJECT_UNAUTHORIZED = "false";
    assert.deepEqual(await runCommand("PING", []), { ok: true, data: "PONG" });
    await server.dropConnections();
    await sleep(300);
    assert.deepEqual(
      await runCommand("PING", []),
      { ok: true, data: "PONG" },
      "a dropped idle connection must reconnect",
    );
    assert.ok(getClient().options.tls, "rediss:// must have turned TLS on");
  });

  it("refuses the fixture's self-signed certificate when verification is on", async () => {
    // The control for the NODE_EXTRA_CA_CERTS cases below: without a trusted CA
    // the handshake must fail, or those cases prove nothing.
    await shutdown();
    process.env.REDIS_URL = `rediss://127.0.0.1:${server.port}`;
    delete process.env.REDIS_TLS_REJECT_UNAUTHORIZED;
    const reply = await runCommand("PING", []);
    assert.equal(reply.ok, false, JSON.stringify(reply));
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

/**
 * The newest oam this box can run at or above the launcher's floor: OAM_BIN,
 * `oam` on PATH, then the default install locations, each asked for its
 * version with the launcher's own 5s budget. Discovery here is deliberately
 * its own few lines rather than the launcher's: the launcher's discovery is
 * what the cases below exercise. The skip reason names every candidate that
 * answered, and every one that was present but would not, so "no oam" and
 * "an oam that is broken" read differently.
 */
function findOam(): { path: string; version: string } | { skip: string } {
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
    if (!best || atLeast(version, best.version)) best = { path: candidate, version, text: match[0] };
  }
  const floor = launcherFloor();
  if (best && atLeast(best.version, floor)) return { path: best.path, version: best.text };
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
 * variable, NODE_OPTIONS (which could preload into the Node side) and
 * NODE_EXTRA_CA_CERTS (which would trust the fixture where a case means not
 * to), then set exactly what each case needs.
 */
function cleanEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(REDIS_|OAM_|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$)/i.test(key)),
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
  });
});

const oam = findOam();
const skip = built || ("skip" in oam ? oam.skip : false);

describe(`rediss:// under a real oam${"path" in oam ? ` (${oam.version} at ${oam.path})` : ""}`, { skip }, () => {
  let server: TlsRespServer;
  let env: NodeJS.ProcessEnv;
  let caDir: string;
  const oamPath = "path" in oam ? oam.path : "";
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
    // REDIS_MCP_RUNTIME=oam here: under `auto` the sandbox can silently not
    // apply, and this case is about --permission being in force.
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
    const run = await mcpPing(oamPath, ["run", LAUNCHER], env, t.signal, 2, async () => {
      await server.dropConnections();
      // The client's `end` arrives one loopback packet later; a short pause
      // keeps the second PING from racing the drop it is meant to survive.
      await sleep(250);
    });
    assert.deepEqual(run.results, [PONG, PONG], JSON.stringify(run));
    assert.match(run.stderr, servedByOam);
    assert.equal(run.code, 0);
  });

  it("verifies a private CA named only by NODE_EXTRA_CA_CERTS, sandbox included", { timeout }, async (t) => {
    // Verification on (REDIS_TLS_REJECT_UNAUTHORIZED unset), the fixture's
    // certificate trusted through the variable alone. oam reads it before the
    // sandbox applies, so --allow-env need not list it.
    const trusted = cleanEnv({
      REDIS_URL: `rediss://127.0.0.1:${server.port}`,
      NODE_EXTRA_CA_CERTS: join(caDir, "ca.pem"),
    });
    for (const [label, command, args, extra] of [
      ["oam run", oamPath, ["run", LAUNCHER], {}],
      [
        "sandboxed",
        process.execPath,
        [LAUNCHER],
        { OAM_BIN: oamPath, REDIS_MCP_RUNTIME: "oam", REDIS_MCP_SANDBOX: "1" },
      ],
    ] as const) {
      const run = await mcpPing(command, [...args], { ...trusted, ...extra }, t.signal);
      assert.deepEqual(run.results, [PONG], `${label}: ${JSON.stringify(run)}`);
      assert.match(run.stderr, servedByOam, label);
      assert.equal(run.code, 0, label);
    }
    // Control: the same run without the CA must fail, or the pass above could
    // come from a runtime that does not verify at all.
    const untrusted = cleanEnv({ REDIS_URL: `rediss://127.0.0.1:${server.port}` });
    const control = await mcpPing(oamPath, ["run", LAUNCHER], untrusted, t.signal);
    assert.notDeepEqual(control.results, [PONG], `without the CA the handshake must fail: ${JSON.stringify(control)}`);
    assert.equal(control.results.length, 1, JSON.stringify(control));
  });
});
