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

const ALL_MEMBERS: ShimmedMember[] = ["setNoDelay", "setKeepAlive", "setTimeout", "connecting"];

/**
 * A stream shaped like oam's `tls.TLSSocket` (0.9.0 - 0.15.2): a Duplex-ish
 * emitter flagged `encrypted`, with none of the `net.Socket` members and no
 * `connecting`. `present` adds back the named members, Node-style, so a case
 * can prove the shim only fills what is missing.
 */
function oamShapedSocket(present: ShimmedMember[] = []) {
  const socket = new EventEmitter() as EventEmitter & {
    encrypted: boolean;
    destroyed: boolean;
    connecting?: boolean;
    setNoDelay?: () => unknown;
    setKeepAlive?: () => unknown;
    setTimeout?: () => unknown;
  };
  socket.encrypted = true;
  socket.destroyed = false;
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
    assert.deepEqual(shimSocket(socket as never), ALL_MEMBERS);
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
    assert.equal(socket.listenerCount("secureConnect"), 0, "no listeners were added");
    assert.equal(socket.listenerCount("close"), 0, "no listeners were added");
  });

  it("fills only the gaps when a socket has some members but not others", () => {
    // The shape a partial upstream fix would produce: oam#132 suggests adding
    // setNoDelay/setKeepAlive first, which would leave setTimeout/connecting.
    const socket = oamShapedSocket(["setNoDelay", "setKeepAlive"]);
    const original = socket.setNoDelay;
    assert.deepEqual(shimSocket(socket as never), ["setTimeout", "connecting"]);
    assert.equal(socket.setNoDelay, original);
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
 * version. Discovery here is deliberately its own few lines rather than the
 * launcher's: the launcher's discovery is what the cases below exercise.
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
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
    const match = probe.status === 0 ? /(\d+)\.(\d+)\.(\d+)/.exec(probe.stdout) : null;
    if (!match) continue;
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

interface McpRun {
  /** The tool result's text, or the JSON-RPC error, or null if neither arrived. */
  result: string | null;
  stderr: string;
  code: number | null;
}

/**
 * Start `command`, complete the MCP handshake, call `redis_command PING`, and
 * close stdin once the answer is in; the server reads that as the client
 * going away and exits on its own.
 */
function mcpPing(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<McpRun> {
  return new Promise((resolvePromise, reject) => {
    const child: ChildProcess = spawn(command, args, {
      cwd: REPO_ROOT,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let result: string | null = null;
    let called = false;
    const send = (message: unknown) => child.stdin?.write(`${JSON.stringify(message)}\n`);
    child.stdin?.on("error", () => {});
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        let message: { id?: number; result?: { content?: { text?: string }[] }; error?: unknown };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1 && !called) {
          called = true;
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "redis_command", arguments: { command: "PING" } },
          });
        } else if (message.id === 2 && result === null) {
          result = message.result?.content?.[0]?.text ?? JSON.stringify(message.error);
          child.stdin?.end();
        }
      }
    });
    child.on("error", reject);
    // `close` rather than `exit`, so both pipes have drained before asserting.
    child.on("close", (code) => resolvePromise({ result, stderr, code }));
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
}

const oam = findOam();
const skip = !existsSync(DIST_BIN) ? "dist/index.js is not built" : "skip" in oam ? oam.skip : false;
// Each case boots an oam, and one also a Node, which is seconds apiece on a
// contended Windows box.
const timeout = 45_000;

describe(`rediss:// under a real oam${"path" in oam ? ` (${oam.version} at ${oam.path})` : ""}`, { skip }, () => {
  let server: TlsRespServer;
  let env: NodeJS.ProcessEnv;
  const oamPath = "path" in oam ? oam.path : "";

  before(async () => {
    server = await startTlsRespServer();
    // The developer's shell must not be able to change what is asserted: drop
    // every REDIS_* and OAM_* variable, then set exactly what each case needs.
    env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(REDIS_|OAM_)/i.test(key)));
    env.REDIS_URL = `rediss://127.0.0.1:${server.port}`;
    env.REDIS_TLS_REJECT_UNAUTHORIZED = "false";
  });
  after(() => server.close());

  it("control: a stock ioredis client still fails under this oam, so the cases below exercise the gap", {
    timeout,
  }, () => {
    // When this fails with PONG, oam has closed YawLabs/oam#132: the shim in
    // src/tls-compat.ts can be retired once the launcher floor passes that
    // release, and this control goes with it.
    const run = spawnSync(oamPath, ["run", RAW_PING], {
      cwd: REPO_ROOT,
      env,
      encoding: "utf8",
      timeout,
      windowsHide: true,
    });
    const line = run.stdout.trim().split("\n").pop() ?? "";
    assert.notEqual(
      line,
      "PONG",
      `oam ${"version" in oam ? oam.version : ""} serves rediss:// without the shim -- retire it`,
    );
    assert.match(line, /^THREW /, `expected the stock client to fail, got ${JSON.stringify(run)}`);
  });

  it("answers PING when the host runs the launcher under `oam run` (served in-process)", { timeout }, async () => {
    const run = await mcpPing(oamPath, ["run", LAUNCHER], env);
    assert.equal(run.result, JSON.stringify("PONG"), JSON.stringify(run));
    assert.match(run.stderr, /using in-process shims/, "the shim must have engaged, proving this ran under oam");
    assert.equal(run.code, 0);
  });

  it("answers PING when the launcher discovers that oam and spawns it", { timeout }, async () => {
    // REDIS_MCP_RUNTIME=oam turns any fallback to Node into a failure, so a
    // pass here cannot come from Node quietly serving instead.
    const run = await mcpPing(process.execPath, [LAUNCHER], { ...env, OAM_BIN: oamPath, REDIS_MCP_RUNTIME: "oam" });
    assert.equal(run.result, JSON.stringify("PONG"), JSON.stringify(run));
    assert.match(run.stderr, /using in-process shims/, "the shim must have engaged, proving this ran under oam");
    assert.equal(run.code, 0);
  });

  it("answers PING inside the sandbox, whose net grant is the rediss:// host and port", { timeout }, async () => {
    const run = await mcpPing(process.execPath, [LAUNCHER], {
      ...env,
      OAM_BIN: oamPath,
      REDIS_MCP_RUNTIME: "oam",
      REDIS_MCP_SANDBOX: "1",
    });
    assert.equal(run.result, JSON.stringify("PONG"), JSON.stringify(run));
    assert.match(run.stderr, /using in-process shims/, "the shim must have engaged, proving this ran under oam");
    assert.equal(run.code, 0);
  });
});
