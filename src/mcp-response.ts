/**
 * Pure adapter: maps a tool handler's { ok, data?, error? } envelope into the
 * MCP CallToolResult shape (a single text content block, with isError set on
 * failures). Extracted from index.ts so it is unit-testable WITHOUT importing
 * index.ts, which starts the stdio server on import (top-level
 * `await server.connect`). The handler-registration loop in index.ts routes
 * both its success and its catch path through this function.
 */

/** The { ok, data?, error? } envelope every tool handler returns. */
export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

/**
 * The subset of the MCP CallToolResult shape this server emits. The
 * `[key: string]: unknown` index signature is required so a value of this named
 * type (not just a fresh object literal) is assignable to the SDK's tool-callback
 * return type, which carries an index signature for forward-compatible fields.
 */
export interface McpToolResponse {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export function toMcpResponse(result: unknown): McpToolResponse {
  const response = result as ToolResult;
  if (!response.ok) {
    return {
      content: [{ type: "text", text: `Error: ${response.error || "Unknown error"}` }],
      isError: true,
    };
  }
  const text = JSON.stringify(response.data ?? { success: true }, null, 2);
  return { content: [{ type: "text", text }] };
}
