/**
 * ioredis connector that fills the gaps in oam's `tls.TLSSocket`.
 *
 * In Node, `tls.TLSSocket` extends `net.Socket`, so a TLS stream carries the
 * whole socket API. In oam 0.9.0 through 0.15.2 the two classes share no
 * base: the TLS one is a bare Duplex. (oam fixed all of the below on its main
 * branch in YawLabs/oam#141, after 0.15.2; once that ships and the launcher
 * floor passes it, this file can go.) Measured against oam 0.15.2, that
 * socket differs from Node in three ways ioredis depends on:
 *
 *   - No `setNoDelay`, `setKeepAlive` or `setTimeout` (YawLabs/oam#132, which
 *     also lists `ref`, `unref` and `address`; ioredis does not call those).
 *     ioredis calls `stream.setNoDelay(true)` as soon as the stream exists,
 *     because `noDelay` defaults to `true`, and a `TypeError` thrown from
 *     inside that connect callback is uncaught -- so under oam a `rediss://`
 *     URL killed the server on its first command. `setKeepAlive(true, 0)`
 *     follows once connected (`keepAlive` defaults to `0`, a number), and
 *     `setTimeout(connectTimeout, cb)` arms the connect timeout.
 *   - No `connecting` flag. Not in oam#132 as filed. ioredis only arms the
 *     connect timeout, and only waits for `secureConnect`, while
 *     `stream.connecting` is true; with it undefined ioredis takes the
 *     "already connected" branch, writes before the handshake, and oam answers
 *     `TLSSocket: not connected`.
 *   - No `close` after the peer ends the session. Also not in oam#132. Node's
 *     socket ends its own side and destroys itself when the peer's FIN
 *     arrives (`allowHalfOpen: false`), so `close` follows `end`; oam's emits
 *     `end` and `finish` and then nothing, with `destroyed` still false.
 *     ioredis learns that a connection is gone only from `close`, so a
 *     managed Redis dropping an idle connection left the client in `ready`
 *     forever: every later command timed out and no reconnect was attempted.
 *
 * Turning the ioredis options off (`noDelay: false`, `keepAlive: null`) only
 * clears the first two calls, changes TCP behaviour on Node too, and leaves
 * everything else. Routing `rediss://` to Node in the launcher only moves the
 * problem: under `oam run` that is a hand-off to a Node on PATH, which an
 * oam-only host does not have, and it drops the sandbox either way.
 *
 * So the fix sits where the stream is born. `TlsCompatConnector` is ioredis's
 * own `StandaloneConnector` with one extra step: after the stream exists and
 * before ioredis touches it, `shimSocket` feature-detects each missing piece
 * and supplies it. Nothing is keyed on `process.versions.oam`: a Node stream
 * already has everything and is returned untouched, and an oam whose TLS
 * socket has these members (oam#141) is likewise left alone, member by
 * member, without a change here.
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

export type ShimmedMember = "setNoDelay" | "setKeepAlive" | "setTimeout" | "connecting" | "closeOnEnd";

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
 * `setTimeout(0)` disarms it (and, like Node, removes a `cb` passed with it),
 * re-arming replaces the timer, and a destroyed socket ignores the call. It
 * is a plain timer, not Node's idle timer: bytes on the socket do not reset
 * it. ioredis only arms it for the connect timeout and clears it on
 * `secureConnect`, so a handshake that is still making progress when the
 * timer fires is treated as hung, which is the stricter reading. The timer is
 * unref'd, so it never keeps the process alive, and it is dropped when the
 * socket closes, so a socket that already failed cannot report a timeout
 * afterwards.
 *
 * `connecting` starts true and clears on `connect` or `secureConnect`, or on
 * `close` for a socket that never got there. Node clears it at the TCP
 * `connect`, before the handshake; oam emits no `connect` for a TLS socket,
 * so `secureConnect` is the earliest signal there. ioredis reads the flag once,
 * when the stream is new, and then waits for `secureConnect` on its own. A
 * socket already destroyed when it gets here (Node can fail a connect before
 * the first microtask) starts false, as Node's would.
 *
 * `closeOnEnd` has no member to detect, so it rides on the others: a socket
 * that needed any of the above is the bare-Duplex TLS socket, and that one
 * never destroys itself after the peer's `end`. Destroying it there is what
 * Node does for a socket with `allowHalfOpen: false`, and it is the `close`
 * ioredis needs to notice the drop and reconnect. A Node socket, which
 * already does this, is not touched.
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
      if (s.destroyed) return s;
      disarm();
      if (Number.isFinite(timeout) && timeout > 0) {
        if (typeof callback === "function") s.once("timeout", callback);
        timer = setTimeout(() => {
          timer = undefined;
          s.emit("timeout");
        }, timeout);
        timer.unref();
      } else if (typeof callback === "function") {
        s.removeListener("timeout", callback);
      }
      return s;
    };
    s.once("close", disarm);
    shimmed.push("setTimeout");
  }
  if (s.connecting === undefined) {
    s.connecting = !s.destroyed;
    if (s.connecting) {
      const connected = () => {
        s.connecting = false;
        s.removeListener("connect", connected);
        s.removeListener("secureConnect", connected);
        s.removeListener("close", connected);
      };
      s.once("connect", connected);
      s.once("secureConnect", connected);
      s.once("close", connected);
    }
    shimmed.push("connecting");
  }
  if (shimmed.length > 0) {
    s.once("end", () => {
      if (!s.destroyed) s.destroy();
    });
    shimmed.push("closeOnEnd");
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
      const members = shimmed.filter((m) => m !== "closeOnEnd");
      console.error(
        `[redis-mcp] TLS socket on ${runtime} has no ${members.join(", ")}; using in-process shims (see YawLabs/oam#132).`,
      );
    }
    return stream;
  }
}
