#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isWritesAllowed, shutdown, validateConfig } from "./api.js";
import { toMcpResponse } from "./mcp-response.js";
import { advisorTools } from "./tools/advisor.js";
import { healthTools } from "./tools/health.js";
import { keyspaceTools } from "./tools/keyspace.js";
import { scanTools } from "./tools/scan-tools.js";

// Injected at build time by esbuild; falls back to reading package.json for tsc builds.
declare const __VERSION__: string | undefined;
const version =
  typeof __VERSION__ !== "undefined"
    ? __VERSION__
    : ((await import("node:module")).createRequire(import.meta.url)("../package.json") as { version: string }).version;

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

// Startup banner on stderr - stdio MCP protocol uses stdout, so stderr is free for logs.
const writesNote = isWritesAllowed() ? "writes ENABLED" : "read-only";
console.error(`@yawlabs/redis-mcp v${version} ready (${allTools.length} tools, ${writesNote})`);

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
