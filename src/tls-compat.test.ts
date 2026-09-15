import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Redis } from "ioredis";
import { getClient } from "./api.js";
import { type ShimmedMember, shimSocket, TlsCompatConnector } from "./tls-compat.js";
import { startTlsRespServer, type TlsRespServer } from "./tls-fixture.js";

// Resolve via import.meta.url so this works regardless of process.cwd(); the
// compiled file lives in dist/, one level below the repo root.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = resolve(REPO_ROOT, "bin", "redis-mcp.mjs");
const DIST_BIN = resolve(REPO_ROOT, "dist", "index.js");
const RAW_PING = resolve(REPO_ROOT, "dist", "tls-fixture-raw-ping.js");
const PROBE = resolve(REPO_ROOT, "dist", "tls-fixture-probe.js");

type Member = Exclude<ShimmedMember, "closeOnEnd">;
const ALL_MEMBERS: Member[] = ["setNoDelay", "setKeepAlive", "setTimeout", "connecting"];
/** What `shimSocket` reports for a socket missing everything. */
const ALL_SHIMMED: ShimmedMember[] = [...ALL_MEMBERS, "closeOnEnd"];

/**
 * A stream shaped like oam's `tls.TLSSocket` (0.9.0 - 0.15.2): a Duplex-ish
 * emitter flagged `encrypted`, with none of the `net.Socket` members and no
 * `connecting`, whose `destroy()` emits `close` the way a Duplex's does.
 * `present` adds back the named members, Node-style, so a case can prove the
 * shim only fills what is missing.
 */
function oamShapedSocket(present: Member[] = []) {
  const socket = new EventEmitter() as EventEmitter & {
    encrypted: boolean;
    destroyed: boolean;
    connecting?: boolean;
    setNoDelay?: () => unknown;
    setKeepAlive?: () => unknown;
    setTimeout?: () => unknown;
    destroy: () => unknown;
  };
  socket.encrypted = true;
  socket.destroyed = false;
  socket.destroy = () => {
    if (socket.destroyed) return socket;
    socket.destroyed = true;
    queueMicrotask(() => socket.emit("close", false));
    return socket;
  };
  for (const member of present) {
    if (member === "connecting") socket.connecting = true;
    else socket[member] = () => socket;
  }
  return socket;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("shimSocket", () => {
  it("supplies every member oam's TLS socket lacks, chainable, and reports them", () => {
    const socket = oamShapedSocket();
    assert.deepEqual(shimSocket(socket as never), ALL_SHIMMED);
    assert.equal(socket.setNoDelay?.(), socket, "setNoDelay must return the socket, as Node's does");
    assert.equal(socket.setKeepAlive?.(), socket, "setKeepAlive must return the socket, as Node's does");
    assert.equal(socket.setTimeout?.(), socket, "setTimeout must return the socket, as Node's does");
  });

  it("leaves a Node-shaped socket untouched", () => {
    const socket = oamShapedSocket(ALL_MEMBERS);
    const before = { ...socket };
    assert.deepEqual(shimSocket(socket as never), []);
    for (const member of ["setNoDelay", "setKeepAlive", "setTimeout"] as const) {
      assert.equal(socket[member], before[member], `${member} must not be replaced`);
    }
    assert.equal(socket.connecting, true);
    for (const event of ["connect", "secureConnect", "close", "end"]) {
      assert.equal(socket.listenerCount(event), 0, `no ${event} listener was added`);
    }
  });

  it("fills only the gaps when a socket has some members but not others", () => {
    // The shape a partial upstream fix would produce: oam#132 lists the
    // methods but not `connecting`, so an oam that closes it exactly as filed
    // still needs the flag -- and, having needed something, the end handling.
    const socket = oamShapedSocket(["setNoDelay", "setKeepAlive", "setTimeout"]);
    const original = socket.setNoDelay;
    assert.deepEqual(shimSocket(socket as never), ["connecting", "closeOnEnd"]);
    assert.equal(socket.setNoDelay, original);
  });

  it("destroys the socket when the peer ends it, so ioredis gets the close it reconnects on", async () => {
    // oam's TLS socket emits `end` and then nothing: `destroyed` stays false,
    // no `close` follows, and ioredis stays in `ready` on a dead connection.
    const socket = oamShapedSocket();
    shimSocket(socket as never);
    let closed = 0;
    socket.on("close", () => closed++);
    socket.emit("end");
    assert.equal(socket.destroyed, true, "end must destroy the socket");
    await sleep(0);
    assert.equal(closed, 1, "destroy must have produced the close");

    // Never twice: a socket already destroyed by the time `end` arrives.
    const gone = oamShapedSocket();
    shimSocket(gone as never);
    let destroys = 0;
    const destroy = gone.destroy;
    gone.destroy = () => {
      destroys++;
      return destroy();
    };
    gone.destroy();
    gone.emit("end");
    assert.equal(destroys, 1);
  });

  it("starts connecting=false on a socket that is already destroyed, as Node does", () => {
    // Node can fail a connect (EADDRNOTAVAIL, port 0) before the microtask in
    // which the shim runs; ioredis then takes its `stream.destroyed` branch and
    // must not be told the socket is still connecting.
    const socket = oamShapedSocket();
    socket.destroyed = true;
    assert.deepEqual(shimSocket(socket as never), ALL_SHIMMED);
    assert.equal(socket.connecting, false);
    assert.equal(socket.listenerCount("secureConnect"), 0, "nothing to wait for on a dead socket");
  });

  it("reports connecting until secureConnect, so ioredis waits for the handshake", () => {
    // Without this ioredis takes its "already connected" branch: it writes
    // before the handshake, oam answers `TLSSocket: not connected`, and the
    // connect timeout is never armed.
    const socket = oamShapedSocket();
    shimSocket(socket as never);
    assert.equal(socket.connecting, true);
    // `close` also carries the setTimeout shim's disarm listener, which stays.
    const closeListeners = socket.listenerCount("close");
    socket.emit("secureConnect");
    assert.equal(socket.connecting, false);
    assert.equal(socket.listenerCount("connect"), 0, "the other one-shot listeners are removed");
    assert.equal(socket.listenerCount("close"), closeListeners - 1, "the other one-shot listeners are removed");
  });

  it("clears connecting on connect for a plain socket, and on close for one that never connected", () => {
    const plain = oamShapedSocket();
    plain.encrypted = false;
    shimSocket(plain as never);
    plain.emit("connect");
    assert.equal(plain.connecting, false);

    const refused = oamShapedSocket();
    shimSocket(refused as never);
    refused.emit("close", true);
    assert.equal(refused.connecting, false);
  });

  /** A shimmed socket with its `setTimeout` typed the way ioredis calls it. */
  function shimmedWithTimer() {
    const socket = oamShapedSocket() as ReturnType<typeof oamShapedSocket> & {
      setTimeout: (ms: number, cb?: () => void) => unknown;
    };
    shimSocket(socket as never);
    return socket;
  }

  it("setTimeout arms a timer that emits timeout and runs the callback once", async () => {
    const socket = shimmedWithTimer();
    let calls = 0;
    let events = 0;
    socket.on("timeout", () => events++);
    socket.setTimeout(20, () => calls++);
    await sleep(60);
    assert.equal(calls, 1);
    assert.equal(events, 1);
    await sleep(40);
    assert.equal(events, 1, "a fired timer does not fire again");
  });

  it("setTimeout(0) disarms, re-arming replaces, and close drops the timer", async () => {
    const disarmed = shimmedWithTimer();
    let fired = 0;
    disarmed.on("timeout", () => fired++);
    disarmed.setTimeout(20);
    disarmed.setTimeout(0);

    const rearmed = shimmedWithTimer();
    let rearmedFired = 0;
    rearmed.on("timeout", () => rearmedFired++);
    rearmed.setTimeout(20);
    rearmed.setTimeout(500);

    const closed = shimmedWithTimer();
    let closedFired = 0;
    closed.on("timeout", () => closedFired++);
    closed.setTimeout(20);
    closed.emit("close", false);

    await sleep(80);
    assert.equal(fired, 0, "setTimeout(0) must cancel the pending timer");
    assert.equal(rearmedFired, 0, "re-arming replaces the earlier, shorter timer");
    assert.equal(closedFired, 0, "a closed socket must not report a timeout afterwards");
    rearmed.setTimeout(0); // so the 500ms timer does not outlive the test
  });

  it("setTimeout follows Node on the edges: (0, cb) removes cb, and a destroyed socket ignores the call", () => {
    const socket = shimmedWithTimer();
    const cb = () => {};
    socket.setTimeout(1000, cb);
    assert.equal(socket.listenerCount("timeout"), 1);
    socket.setTimeout(0, cb);
    assert.equal(socket.listenerCount("timeout"), 0, "Node's setTimeout(0, cb) removes cb rather than adding it");

    socket.destroyed = true;
    assert.equal(socket.setTimeout(1000, cb), socket, "still chainable");
    assert.equal(socket.listenerCount("timeout"), 0, "a destroyed socket arms nothing");
  });

  it("the replacements do not depend on how they are invoked", () => {
    // ioredis calls them as methods; a detached call must still work.
    const socket = shimmedWithTimer();
    const { setNoDelay, setKeepAlive, setTimeout: setTimeoutDetached } = socket;
    assert.equal(setNoDelay?.(), socket);
    assert.equal(setKeepAlive?.(), socket);
    assert.equal(setTimeoutDetached(0), socket);
  });
});

describe("TlsCompatConnector", () => {
  let server: TlsRespServer;
  before(async () => {
    server = await startTlsRespServer();
  });
  after(() => server.close());

  it("is ioredis's own StandaloneConnector plus the shim", () => {
    // The class is reached through a CJS/ESM interop seam; a wrong unwrap
    // would extend the module namespace object, or nothing.
    assert.equal(Object.getPrototypeOf(TlsCompatConnector).name, "StandaloneConnector");
    const connector = new TlsCompatConnector({});
    assert.equal(typeof connector.connect, "function");
    assert.equal(typeof connector.disconnect, "function");
  });

  it("connects over rediss:// on Node without shimming or announcing anything", async () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (msg?: unknown) => {
      lines.push(String(msg));
    };
    const client = new Redis(`rediss://127.0.0.1:${server.port}`, {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      tls: { rejectUnauthorized: false },
      Connector: TlsCompatConnector,
    });
    try {
      assert.equal(await client.ping(), "PONG");
      assert.deepEqual(
        lines.filter((l) => l.includes("in-process shims")),
        [],
        "a Node TLS socket has every member, so nothing is shimmed or announced",
      );
    } finally {
      console.error = original;
      client.disconnect();
    }
  });

  it("still reconnects on Node after the server drops the connection", async () => {
    // Node's socket closes itself after `end`; the connector must not get in
    // the way of the `close` ioredis reconnects on.
    const client = new Redis(`rediss://127.0.0.1:${server.port}`, {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      retryStrategy: () => 50,
      tls: { rejectUnauthorized: false },
      Connector: TlsCompatConnector,
    });
    client.on("error", () => {});
    const seenBefore = server.received.length;
    try {
      assert.equal(await client.ping(), "PONG");
      await server.dropConnections();
      await sleep(100);
      assert.equal(await client.ping(), "PONG", "the second PING must go over a new connection");
      const pings = server.received.slice(seenBefore).filter((c) => c[0]?.toUpperCase() === "PING");
      assert.equal(pings.length, 2, "both PINGs reached the server, one per connection");
    } finally {
      client.disconnect();
    }
  });

  it("is what getClient() installs", () => {
    // The wiring, not the class: without this the shim exists and is never used.
    const original = process.env.REDIS_URL;
    process.env.REDIS_URL = "rediss://127.0.0.1:1";
    try {
      // lazyConnect: nothing is dialled, port 1 is never reached.
      const client = getClient();
      assert.equal(client.options.Connector, TlsCompatConnector);
      client.disconnect();
    } finally {
      if (original === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = original;
    }
  });
});

/* ---------- end to end, under a real oam when one is installed ---------- */

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
        clientInfo: { name: "tls-compat-test", version: "0" },
      },
    });
  });
  return { results, stderr: run.stderr, code: run.code };
}

const oam = findOam();
const skip = !existsSync(DIST_BIN) ? "dist/index.js is not built" : "skip" in oam ? oam.skip : false;
// Each case boots an oam, and some also a Node, which is seconds apiece on a
// contended Windows box.
const timeout = 45_000;
const PONG = JSON.stringify("PONG");
const SHIMMED = /using in-process shims/;

describe(`rediss:// under a real oam${"path" in oam ? ` (${oam.version} at ${oam.path})` : ""}`, { skip }, () => {
  let server: TlsRespServer;
  let env: NodeJS.ProcessEnv;
  /** What this oam's TLS socket is missing, as the server's shim sees it. */
  let shimmed: ShimmedMember[] = [];
  const oamPath = "path" in oam ? oam.path : "";
  const oamVersion = "version" in oam ? oam.version : "";
  /** The banner the server prints when oam, not a Node fallback, is serving. */
  const servedByOam = new RegExp(`ready \\(.*\\) on oam ${oamVersion.replace(/\./g, "\\.")}`);

  before(async () => {
    server = await startTlsRespServer();
    // The developer's shell must not be able to change what is asserted: drop
    // every REDIS_* and OAM_* variable (and NODE_OPTIONS, which could preload
    // into the Node side), then set exactly what each case needs.
    env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(REDIS_|OAM_|NODE_OPTIONS$)/i.test(key)));
    env.REDIS_URL = `rediss://127.0.0.1:${server.port}`;
    env.REDIS_TLS_REJECT_UNAUTHORIZED = "false";
    // Ask this oam what it lacks, with the server's own detection, so every
    // case below can say whether the shim should have engaged. On oam 0.15.2
    // that is everything; on an oam that has grown the net.Socket API it is
    // nothing, and the cases then prove the shim stays out of the way.
    const probe = await collect(oamPath, ["run", PROBE], env, AbortSignal.timeout(timeout));
    const line = probe.stdout.trim().split("\n").pop() ?? "";
    const parsed = JSON.parse(line || "null") as {
      extends?: string;
      connect?: string;
      shimmed?: ShimmedMember[];
    } | null;
    assert.equal(parsed?.extends, "StandaloneConnector", `the probe must run under oam: ${JSON.stringify(probe)}`);
    assert.equal(parsed?.connect, "function");
    shimmed = parsed?.shimmed ?? [];
  });
  after(() => server.close());

  /** The shim must have announced itself exactly when this oam needed it. */
  function assertShimAnnouncement(t: { diagnostic: (message: string) => void }, stderr: string) {
    if (shimmed.length > 0) {
      assert.match(stderr, SHIMMED, `oam ${oamVersion} lacks ${shimmed.join(", ")}, so the shim must have engaged`);
    } else {
      assert.doesNotMatch(stderr, SHIMMED, `oam ${oamVersion} has the whole net.Socket API, so the shim must stay out`);
      t.diagnostic(`oam ${oamVersion} needs no TLS shim; the tls-compat shim is dormant on this box`);
    }
  }

  it("control: a stock ioredis client fails under this oam exactly when the shim reports a gap", {
    timeout,
  }, async (t) => {
    // Spawned asynchronously, so the fixture in this process can answer: a
    // stock client that works must be able to reach PONG here, otherwise this
    // control could never tell the two states apart. This is what makes the
    // cases below evidence: they exercise a real gap, or prove the shim is
    // inert on an oam without one.
    const run = await collect(oamPath, ["run", RAW_PING], env, t.signal);
    const line = run.stdout.trim().split("\n").pop() ?? "";
    if (shimmed.length > 0) {
      assert.match(
        line,
        /^THREW (stream\.(setNoDelay|setKeepAlive|setTimeout) is not a function|Connection is closed\.)/,
        `oam ${oamVersion} lacks ${shimmed.join(", ")}, so a stock client should fail, got ${JSON.stringify(run)}`,
      );
    } else {
      assert.equal(
        line,
        "PONG",
        `oam ${oamVersion} reports no gap, so a stock client should work, got ${JSON.stringify(run)}`,
      );
      t.diagnostic(`a stock ioredis client works over rediss:// on oam ${oamVersion} (YawLabs/oam#132 is fixed there)`);
    }
  });

  it("answers PING when the host runs the launcher under `oam run` (served in-process)", { timeout }, async (t) => {
    const run = await mcpPing(oamPath, ["run", LAUNCHER], env, t.signal);
    assert.deepEqual(run.results, [PONG], JSON.stringify(run));
    assert.match(run.stderr, servedByOam);
    assertShimAnnouncement(t, run.stderr);
    assert.equal(run.code, 0);
  });

  it("answers PING when the launcher, in its default auto mode, discovers that oam and spawns it", {
    timeout,
  }, async (t) => {
    // REDIS_MCP_RUNTIME is unset, so this is the configuration issue #12 names
    // and every user gets by default. `auto` may fall back to Node, which
    // would also answer PONG; the banner match is what rules that out.
    const run = await mcpPing(process.execPath, [LAUNCHER], { ...env, OAM_BIN: oamPath }, t.signal);
    assert.deepEqual(run.results, [PONG], JSON.stringify(run));
    assert.match(run.stderr, servedByOam, `oam must have served, not a Node fallback: ${JSON.stringify(run)}`);
    assertShimAnnouncement(t, run.stderr);
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
    assertShimAnnouncement(t, run.stderr);
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
      assertShimAnnouncement(t, run.stderr);
      assert.equal(run.code, 0);
    } finally {
      await v6.close();
    }
  });

  it("reconnects after the server drops the connection, instead of timing out forever", { timeout }, async (t) => {
    // A managed Redis ends idle connections. oam 0.15.2's TLS socket emits
    // `end` and then nothing, so without the shim's close-on-end ioredis never
    // noticed, stayed `ready`, and every later command hit the command
    // timeout. On an oam that closes after `end` itself this passes unshimmed.
    const run = await mcpPing(oamPath, ["run", LAUNCHER], env, t.signal, 2, async () => {
      await server.dropConnections();
      // The client's `end` arrives one loopback packet later; a short pause
      // keeps the second PING from racing the drop it is meant to survive.
      await sleep(250);
    });
    assert.deepEqual(run.results, [PONG, PONG], JSON.stringify(run));
    assert.match(run.stderr, servedByOam);
    assertShimAnnouncement(t, run.stderr);
    assert.equal(run.code, 0);
  });
});
