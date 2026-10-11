/**
 * Test-only plain-TCP RESP server: the `redis://` sibling of tls-fixture.ts's
 * TLS one. It answers like a Redis with nothing in it -- `PING` -> `+PONG`,
 * `INFO` -> an empty bulk string (enough for ioredis's ready check), `QUIT`
 * -> `+OK` and close -- plus whatever `replies` adds, and `-ERR` for anything
 * else. No Redis binary needed.
 *
 * Used by the unit suite and by scripts/check-compliance.mjs, which imports the
 * compiled dist/resp-fixture.js so the compliance run has a REDIS_URL to point
 * the server at. No `.test.` in the name, so the runner never executes it.
 */

import { type AddressInfo, createServer, type Socket } from "node:net";
import { takeCommands } from "./tls-fixture.js";

/** A RESP reply for one command, already encoded (`+OK\r\n`, `$3\r\nabc\r\n`, ...). */
export type RespReply = (args: string[]) => string;

export interface RespServer {
  port: number;
  /** Every command received, in order, across all connections. */
  received: string[][];
  close(): Promise<void>;
}

/** RESP-encode a bulk string. */
export function bulk(value: string): string {
  return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
}

/** RESP-encode an integer. */
export function int(value: number): string {
  return `:${value}\r\n`;
}

export function startRespServer(replies: Record<string, RespReply> = {}, host = "127.0.0.1"): Promise<RespServer> {
  const received: string[][] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
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
        const name = (parts[0] ?? "").toUpperCase();
        const custom = replies[name];
        if (custom) {
          socket.write(custom(parts.slice(1)));
          continue;
        }
        switch (name) {
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
        received,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}
