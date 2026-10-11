import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SERVER_INSTRUCTIONS, SERVER_INSTRUCTIONS_CAP_BYTES } from "./server-instructions.js";
import { advisorTools } from "./tools/advisor.js";
import { healthTools } from "./tools/health.js";
import { keyspaceTools } from "./tools/keyspace.js";
import { scanTools } from "./tools/scan-tools.js";

describe("server instructions", () => {
  it("fit under yaw-mcp's 2000-byte ceiling, so no host cuts them", () => {
    assert.equal(SERVER_INSTRUCTIONS_CAP_BYTES, 2000);
    const bytes = Buffer.byteLength(SERVER_INSTRUCTIONS, "utf8");
    assert.ok(bytes > 0 && bytes <= SERVER_INSTRUCTIONS_CAP_BYTES, `${bytes} bytes`);
  });

  it("are plain printable ASCII", () => {
    assert.match(SERVER_INSTRUCTIONS, /^[\x20-\x7e\n]+$/);
  });

  it("name only tools this server registers, and reach every one", () => {
    const registered = new Set<string>(
      [...scanTools, ...keyspaceTools, ...healthTools, ...advisorTools].map((t) => t.name),
    );
    const named = new Set(SERVER_INSTRUCTIONS.match(/\bredis_[a-z_]+/g) ?? []);
    for (const name of named) assert.ok(registered.has(name), `instructions name an unknown tool: ${name}`);
    for (const name of registered) assert.ok(named.has(name), `instructions never route to ${name}`);
  });

  it("carry none of the markers yaw-mcp neutralizes", () => {
    assert.doesNotMatch(SERVER_INSTRUCTIONS, /<<<(BEGIN|END) UPSTREAM SERVER TEXT|\[yaw-mcp\]/i);
  });
});
