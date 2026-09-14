/**
 * ioredis connector that fills the gaps in oam's `tls.TLSSocket`.
 *
 * In Node, `tls.TLSSocket` extends `net.Socket`, so a TLS stream carries the
 * whole socket API. In oam (0.9.0 through at least 0.15.2) the two classes
 * share no base, and the TLS one has no `setNoDelay`, `setKeepAlive`,
 * `setTimeout`, `ref`, `unref` or `address`, and no `connecting` flag
 * (YawLabs/oam#132). ioredis calls three of those on every connection
 * (`ioredis/built/Redis.js`, `connect()`):
 *
 *   - `stream.setNoDelay(true)` right after the stream is created, because
 *     `noDelay` defaults to `true`. `TypeError: stream.setNoDelay is not a
 *     function` from inside a connect callback is uncaught, so under oam a
 *     `rediss://` URL killed the server on its first command.
 *   - `stream.setKeepAlive(true, 0)` once connected, because `keepAlive`
 *     defaults to `0` and `0` is a number.
 *   - `stream.setTimeout(connectTimeout, cb)`, but only while
 *     `stream.connecting` is true. oam's TLS socket has no such property, so
 *     ioredis takes the "already connected" branch instead: it sends its first
 *     bytes before the handshake, oam answers `TLSSocket: not connected`, and
 *     the connect timeout is never armed.
 *
 * Turning the options off (`noDelay: false`, `keepAlive: null`) only clears
 * the first two, changes TCP behaviour on Node too, and leaves the third.
 * Routing `rediss://` to Node in the launcher cannot help a host that runs the
 * launcher under `oam run`, where there is no Node to fall back to.
 *
 * So the fix sits where the stream is born. `TlsCompatConnector` is ioredis's
 * own `StandaloneConnector` with one extra step: after the stream exists and
 * before ioredis touches it, `shimSocket` feature-detects each missing piece
 * and supplies it. Nothing is keyed on `process.versions.oam`: a Node stream
 * already has everything and is returned untouched, and an oam release that
 * closes #132 disables the shim by itself.
 */

import type { StandaloneConnectionOptions } from "ioredis";
import type { ErrorEmitter } from "ioredis/built/connectors/AbstractConnector.js";
import StandaloneConnectorImport from "ioredis/built/connectors/StandaloneConnector.js";
import type { NetStream } from "ioredis/built/types.js";

/**
 * `StandaloneConnector` is not among ioredis's public exports, and the file is
 * CommonJS with `exports.default = StandaloneConnector`. Node gives an ES
 * module's default import of such a file the whole `module.exports`
 * (`{ default: Class }`), which is also how TypeScript types it here and how
 * the esbuild bundle behaves (it mirrors Node for `platform: "node"`); oam
 * unwraps `__esModule` and hands over the class itself. Accept both shapes so
 * the module loads the same way everywhere.
 */
type StandaloneConnectorClass = typeof StandaloneConnectorImport.default;
const StandaloneConnector = (
  typeof StandaloneConnectorImport === "function" ? StandaloneConnectorImport : StandaloneConnectorImport.default
) as StandaloneConnectorClass;

/** The socket surface `shimSocket` may have to supply. */
type ShimmableSocket = NetStream & {
  encrypted?: boolean;
  connecting?: boolean;
  setNoDelay?: (noDelay?: boolean) => unknown;
  setKeepAlive?: (enable?: boolean, initialDelay?: number) => unknown;
  setTimeout?: (timeout: number, callback?: () => void) => unknown;
};

export type ShimmedMember = "setNoDelay" | "setKeepAlive" | "setTimeout" | "connecting";

/**
 * Give `stream` whatever ioredis will call that it does not have, and return
 * the names of what was supplied (empty on Node). Only absent members are
 * touched; a present one is never replaced.
 *
 * The replacements follow oam's own `net.Socket`, whose `setNoDelay` and
 * `setKeepAlive` are chainable no-ops (`js/node_compat.js`), so a shimmed TLS
 * socket behaves like an oam TCP socket, not like something new. `setTimeout`
 * keeps Node's contract as far as ioredis uses it: `setTimeout(ms, cb)` adds
 * `cb` as a one-time `timeout` listener and arms a timer that emits `timeout`,
 * `setTimeout(0)` disarms it, and re-arming replaces the timer. It is a plain
 * timer, not Node's idle timer: bytes on the socket do not reset it. ioredis
 * only arms it for the connect timeout and clears it on `secureConnect`, so a
 * handshake that is still making progress when the timer fires is treated as
 * hung, which is the stricter reading. The timer is unref'd, so it never keeps
 * the process alive, and it is dropped when the socket closes, so a socket
 * that already failed cannot report a timeout afterwards.
 *
 * `connecting` starts true and clears on `connect` or `secureConnect`, or on
 * `close` for a socket that never got there. Node clears it at the TCP
 * `connect`, before the handshake; oam emits no `connect` for a TLS socket,
 * so `secureConnect` is the earliest signal there. ioredis reads the flag once,
 * when the stream is new, and then waits for `secureConnect` on its own.
 */
export function shimSocket(stream: NetStream): ShimmedMember[] {
  const s = stream as ShimmableSocket;
  const shimmed: ShimmedMember[] = [];

  // Each replacement closes over `s` rather than reading `this`, so it works
  // however ioredis (or anything else) ends up invoking it.
  if (typeof s.setNoDelay !== "function") {
    s.setNoDelay = () => s;
    shimmed.push("setNoDelay");
  }
  if (typeof s.setKeepAlive !== "function") {
    s.setKeepAlive = () => s;
    shimmed.push("setKeepAlive");
  }
  if (typeof s.setTimeout !== "function") {
    let timer: NodeJS.Timeout | undefined;
    const disarm = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    s.setTimeout = (timeout: number, callback?: () => void) => {
      disarm();
      if (typeof callback === "function") s.once("timeout", callback);
      if (Number.isFinite(timeout) && timeout > 0) {
        timer = setTimeout(() => {
          timer = undefined;
          s.emit("timeout");
        }, timeout);
        timer.unref();
      }
      return s;
    };
    s.once("close", disarm);
    shimmed.push("setTimeout");
  }
  if (s.connecting === undefined) {
    s.connecting = true;
    const connected = () => {
      s.connecting = false;
      s.removeListener("connect", connected);
      s.removeListener("secureConnect", connected);
      s.removeListener("close", connected);
    };
    s.once("connect", connected);
    s.once("secureConnect", connected);
    s.once("close", connected);
    shimmed.push("connecting");
  }

  return shimmed;
}

let announced = false;

/**
 * ioredis `Connector`: `StandaloneConnector` plus `shimSocket` on every stream
 * it opens, including each reconnect. The first time a stream actually needs
 * shimming, one line on stderr says so, naming the runtime and the members, so
 * a TLS problem under oam can be told apart from one in the server.
 */
export class TlsCompatConnector extends StandaloneConnector {
  // ioredis types a custom `Connector` as `new (options: unknown)`, and passes
  // it the same resolved options object `StandaloneConnector` gets by default.
  constructor(options: unknown) {
    super(options as StandaloneConnectionOptions);
  }

  override async connect(emitter: ErrorEmitter): Promise<NetStream> {
    const stream = await super.connect(emitter);
    const shimmed = shimSocket(stream);
    if (shimmed.length > 0 && !announced) {
      announced = true;
      const runtime = process.versions.oam ? `oam ${process.versions.oam}` : `node ${process.versions.node}`;
      console.error(
        `[redis-mcp] TLS socket on ${runtime} has no ${shimmed.join(", ")}; using in-process shims (see YawLabs/oam#132).`,
      );
    }
    return stream;
  }
}
