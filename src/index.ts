#!/usr/bin/env node

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isWritesAllowed, shutdown, tlsRuntimeProblem, validateConfig, wouldUseTls } from "./api.js";
import { toMcpResponse } from "./mcp-response.js";
import { advisorTools } from "./tools/advisor.js";
import { healthTools } from "./tools/health.js";
import { keyspaceTools } from "./tools/keyspace.js";
import { scanTools } from "./tools/scan-tools.js";

// Injected at build time by esbuild; falls back to reading package.json for tsc builds.
//
// A static import, NOT `(await import("node:module"))`: esbuild folds the
// `typeof` check to `true` but keeps the dead branch, so a dynamic import there
// left a top-level `await` in dist/index.js. oam cannot `import()` a module
// with top-level await, so the launcher's in-process path on an oam host
// reported "fallback to Node failed" and set exit code 1 while the server was
// serving. bundle.test.ts asserts the bundle has none.
declare const __VERSION__: string | undefined;
const version =
  typeof __VERSION__ !== "undefined"
    ? __VERSION__
    : (createRequire(import.meta.url)("../package.json") as { version: string }).version;

// ─── CLI subcommands (run instead of MCP server) ───

const subcommand = process.argv[2];

if (subcommand === "version" || subcommand === "--version") {
  console.log(version);
  process.exit(0);
}

// ─── No subcommand - start the MCP server ───

const allTools = [...scanTools, ...keyspaceTools, ...healthTools, ...advisorTools];

const server = new McpServer({
  name: "@yawlabs/redis-mcp",
  version,
});

for (const tool of allTools) {
  server.tool(
    tool.name,
    tool.description,
    tool.inputSchema.shape,
    tool.annotations,
    async (input: Record<string, unknown>) => {
      try {
        const result = await (tool.handler as (input: unknown) => Promise<unknown>)(input);
        return toMcpResponse(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return toMcpResponse({ ok: false, error: message });
      }
    },
  );
}

// Validate required config eagerly so a missing REDIS_URL (and the Windows
// .mcp.json hint) surfaces in startup logs and exits, instead of deferring the
// error to the first tool call. Only env validation runs here; the TCP connect
// stays lazy inside getClient().
try {
  validateConfig();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`@yawlabs/redis-mcp: ${message}`);
  process.exit(1);
}

const transport = new StdioServerTransport();
// No top-level await: the CJS single-binary build (esbuild SEA) cannot emit
// top-level await. .catch keeps the connect's failure handling behavior.
server.connect(transport).catch((err: unknown) => {
  process.stderr.write(`redis-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

// Startup banner on stderr - stdio MCP protocol uses stdout, so stderr is free
// for logs. It names the runtime because the launcher can end up on either
// (see README "Runtime"), and which one is serving is the first question when
// something runtime-specific, like TLS under oam, goes wrong.
const writesNote = isWritesAllowed() ? "writes ENABLED" : "read-only";
const runtime = process.versions.oam ? `oam ${process.versions.oam}` : `node ${process.versions.node}`;
console.error(`@yawlabs/redis-mcp v${version} ready (${allTools.length} tools, ${writesNote}) on ${runtime}`);
// A host that runs dist/index.js directly under an old oam skips the launcher's
// version floor. Every tool call returns this as its error; saying it once at
// startup too puts the cause in the host's log before anyone calls a tool.
const tlsProblem = wouldUseTls() ? tlsRuntimeProblem() : null;
if (tlsProblem) console.error(`@yawlabs/redis-mcp: ${tlsProblem}`);

// Clean shutdown: close the Redis connection when the transport closes.
const cleanup = async () => {
  try {
    await shutdown();
  } catch {
    // Best-effort - process is exiting.
  }
};
process.on("SIGINT", () => {
  void cleanup().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void cleanup().finally(() => process.exit(0));
});
// MCP clients typically disconnect by closing our stdin rather than sending a
// signal. Without this, ioredis's keepalive can keep node alive after the
// client is gone; proactively clean up and exit.
process.stdin.on("end", () => {
  void cleanup().finally(() => process.exit(0));
});
