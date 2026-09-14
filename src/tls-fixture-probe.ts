/**
 * Test-only executable: report what this runtime's TLS socket is missing, as
 * the server's own shim sees it. Opens a `tls.connect()` socket to the host
 * and port in REDIS_URL (verification off; the fixture certificate is
 * self-signed), runs `shimSocket` on it, and prints one JSON line:
 *
 *   {"extends": <what TlsCompatConnector extends>, "connect": <typeof>,
 *    "shimmed": [<members shimSocket supplied>]}
 *
 * The tls-compat tests run this under a real oam before the end-to-end
 * cases, so they can assert the server announced the shim exactly when this
 * oam needed it: on oam 0.15.2 `shimmed` is every member, on an oam that has
 * grown the `net.Socket` API it is empty and the announcement must be absent.
 * `extends` is here because oam is the one runtime that unwraps
 * `exports.default` on the deep import of ioredis's `StandaloneConnector`
 * (see the note in tls-compat.ts); Node and the esbuild bundle take the other
 * branch, which the in-process tests cover.
 *
 * NOTE: no `.test.` in the name, so the runner never executes it directly.
 */

import { connect } from "node:tls";
import { shimSocket, TlsCompatConnector } from "./tls-compat.js";

const url = new URL(process.env.REDIS_URL ?? "rediss://127.0.0.1:0");
const socket = connect({ host: url.hostname, port: Number(url.port), rejectUnauthorized: false });
socket.on("error", () => {});
const shimmed = shimSocket(socket);
const parent = Object.getPrototypeOf(TlsCompatConnector) as { name?: string };
console.log(JSON.stringify({ extends: parent.name, connect: typeof new TlsCompatConnector({}).connect, shimmed }));
socket.destroy();
