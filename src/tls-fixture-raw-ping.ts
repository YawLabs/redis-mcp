/**
 * Test-only executable: connect to REDIS_URL with a stock ioredis client, no
 * `TlsCompatConnector`, and PING once. The tls-compat tests run this under a
 * real oam as the control for their end-to-end case: while oam's TLS socket
 * lacks `setNoDelay` (YawLabs/oam#132) it dies with the TypeError the server
 * used to die with, which proves the end-to-end case is exercising that gap
 * and not a runtime that happens to work.
 *
 * Prints one line: `PONG` on success, or `THREW <message>` for a thrown error
 * (including an uncaught one), then exits 0 either way; the test reads the
 * line, not the exit code. NOTE: no `.test.` in the name, so the runner never
 * executes it directly.
 */

import { Redis } from "ioredis";

process.on("uncaughtException", (err: Error) => {
  console.log(`THREW ${err.message}`);
  process.exit(0);
});

const client = new Redis(process.env.REDIS_URL ?? "", {
  lazyConnect: true,
  maxRetriesPerRequest: 0,
  retryStrategy: () => null,
  tls: { rejectUnauthorized: false },
});
client.on("error", () => {});
client
  .ping()
  .then((reply) => console.log(reply))
  .catch((err: Error) => console.log(`THREW ${err.message}`))
  .finally(() => {
    client.disconnect();
    process.exit(0);
  });
