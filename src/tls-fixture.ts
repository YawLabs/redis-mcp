/**
 * Test-only TLS fixtures: a throwaway self-signed certificate and a TLS server
 * that speaks just enough RESP to answer the commands ioredis sends on
 * connect. Together they stand in for a managed Redis behind `rediss://`
 * without a Redis binary, a certificate on disk, or openssl.
 *
 * NOTE: no `.test.` in this file's name, so the runner (scripts/run-tests.mjs)
 * never executes it directly; the TLS tests import it.
 */

import { generateKeyPairSync, sign } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createServer, type TLSSocket } from "node:tls";

/* ---------- a minimal DER writer, enough for one self-signed certificate ---------- */

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const len = body.length;
  const lenBytes =
    len < 0x80
      ? Buffer.from([len])
      : len < 0x100
        ? Buffer.from([0x81, len])
        : Buffer.from([0x82, len >> 8, len & 0xff]);
  return Buffer.concat([Buffer.from([tag]), lenBytes, body]);
}
const SEQUENCE = (...parts: Buffer[]) => der(0x30, ...parts);
const SET = (...parts: Buffer[]) => der(0x31, ...parts);
const INTEGER = (n: number) => der(0x02, Buffer.from([n]));
const UTF8STRING = (s: string) => der(0x0c, Buffer.from(s, "utf8"));
const OCTETSTRING = (b: Buffer) => der(0x04, b);
const BITSTRING = (b: Buffer) => der(0x03, Buffer.from([0]), b);
const BOOLEAN_TRUE = der(0x01, Buffer.from([0xff]));
/** Context-specific constructed tag [n]. */
const CONTEXT = (n: number, ...parts: Buffer[]) => der(0xa0 | n, ...parts);
/** UTCTime, YYMMDDHHMMSSZ. */
const UTCTIME = (d: Date) => der(0x17, Buffer.from(`${d.toISOString().replace(/[-:T]/g, "").slice(2, 14)}Z`, "ascii"));
function OID(dotted: string): Buffer {
  const [first, second, ...rest] = dotted.split(".").map(Number) as [number, number, ...number[]];
  const bytes = [40 * first + second];
  for (const arc of rest) {
    const chunk = [arc & 0x7f];
    for (let x = arc >> 7; x > 0; x >>= 7) chunk.unshift((x & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
}

const ECDSA_WITH_SHA256 = SEQUENCE(OID("1.2.840.10045.4.3.2"));
const OID_COMMON_NAME = OID("2.5.4.3");
const OID_SUBJECT_ALT_NAME = OID("2.5.29.17");
const OID_BASIC_CONSTRAINTS = OID("2.5.29.19");

function pem(label: string, body: Buffer): string {
  const lines = body.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/**
 * A fresh EC P-256 key and a self-signed X.509 v3 certificate for it, valid
 * for `127.0.0.1` and `localhost` from an hour ago until tomorrow. Generated
 * in-process every call, so nothing sensitive or expiring is checked in.
 * Verified against openssl (`x509 -text`, `verify -CAfile`) and accepted by
 * both Node's and oam's TLS clients.
 */
export function makeSelfSignedCert(): { key: string; cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const name = SEQUENCE(SET(SEQUENCE(OID_COMMON_NAME, UTF8STRING("redis-mcp test fixture"))));
  const now = Date.now();
  const validity = SEQUENCE(UTCTIME(new Date(now - 3_600_000)), UTCTIME(new Date(now + 86_400_000)));
  const altNames = SEQUENCE(der(0x87, Buffer.from([127, 0, 0, 1])), der(0x82, Buffer.from("localhost", "ascii")));
  const extensions = SEQUENCE(
    SEQUENCE(OID_BASIC_CONSTRAINTS, BOOLEAN_TRUE, OCTETSTRING(SEQUENCE())),
    SEQUENCE(OID_SUBJECT_ALT_NAME, OCTETSTRING(altNames)),
  );
  const tbsCertificate = SEQUENCE(
    CONTEXT(0, INTEGER(2)), // version v3
    INTEGER(1), // serialNumber
    ECDSA_WITH_SHA256,
    name, // issuer
    validity,
    name, // subject
    publicKey.export({ type: "spki", format: "der" }),
    CONTEXT(3, extensions),
  );
  const certificate = SEQUENCE(
    tbsCertificate,
    ECDSA_WITH_SHA256,
    BITSTRING(sign("sha256", tbsCertificate, privateKey)),
  );
  return { key: privateKey.export({ type: "pkcs8", format: "pem" }) as string, cert: pem("CERTIFICATE", certificate) };
}

/* ---------- a TLS server that answers RESP ---------- */

/** Split complete RESP arrays of bulk strings off the front of `buf`. */
function takeCommands(buf: string): { commands: string[][]; rest: string } {
  const commands: string[][] = [];
  let rest = buf;
  for (;;) {
    const header = /^\*(\d+)\r\n/.exec(rest);
    if (!header) break;
    let pos = header[0].length;
    const parts: string[] = [];
    let complete = true;
    for (let i = 0; i < Number(header[1]); i++) {
      const bulk = /^\$(\d+)\r\n/.exec(rest.slice(pos));
      if (!bulk) {
        complete = false;
        break;
      }
      const start = pos + bulk[0].length;
      const end = start + Number(bulk[1]);
      if (rest.length < end + 2) {
        complete = false;
        break;
      }
      parts.push(rest.slice(start, end));
      pos = end + 2;
    }
    if (!complete) break;
    commands.push(parts);
    rest = rest.slice(pos);
  }
  return { commands, rest };
}

export interface TlsRespServer {
  port: number;
  /**
   * The server's self-signed certificate, PEM. It is its own issuer, so a
   * client trusts the server by trusting this (as `ca`, or through
   * NODE_EXTRA_CA_CERTS).
   */
  cert: string;
  /** Every command received, in order, across all connections. */
  received: string[][];
  /**
   * End every live connection from the server side, the way a managed Redis
   * drops an idle client, and resolve once each has fully closed here.
   */
  dropConnections(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Listen on a random port on `host` (127.0.0.1 unless told otherwise, e.g.
 * `::1`) with a fresh self-signed certificate and answer like a Redis with
 * nothing in it: `PING` -> `+PONG`, `INFO` -> an empty bulk string (enough for
 * ioredis's ready check), `QUIT` -> `+OK` and close, anything else -> `-ERR`.
 * Clients must skip verification (`rejectUnauthorized: false`), as the
 * certificate is self-signed. Rejects when `host` cannot be bound, as `::1` on
 * a machine with IPv6 disabled.
 */
export function startTlsRespServer(host = "127.0.0.1"): Promise<TlsRespServer> {
  const { key, cert } = makeSelfSignedCert();
  const received: string[][] = [];
  const sockets = new Set<TLSSocket>();
  const server = createServer({ key, cert }, (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buf = "";
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const { commands, rest } = takeCommands(buf);
      buf = rest;
      for (const parts of commands) {
        received.push(parts);
        switch ((parts[0] ?? "").toUpperCase()) {
          case "PING":
            socket.write("+PONG\r\n");
            break;
          case "INFO":
            socket.write("$0\r\n\r\n");
            break;
          case "QUIT":
            socket.end("+OK\r\n");
            break;
          default:
            socket.write(`-ERR unknown command '${parts[0]}'\r\n`);
        }
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        cert,
        received,
        dropConnections: () =>
          Promise.all(
            [...sockets].map(
              (socket) =>
                new Promise<void>((closed) => {
                  socket.once("close", () => closed());
                  socket.end();
                }),
            ),
          ).then(() => undefined),
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}
