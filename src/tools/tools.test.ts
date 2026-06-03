import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { advisorTools } from "./advisor.js";
import { healthTools } from "./health.js";
import { keyspaceTools } from "./keyspace.js";
import { scanTools } from "./scan-tools.js";

const allTools = [...scanTools, ...keyspaceTools, ...healthTools, ...advisorTools];

describe("Tool definitions", () => {
  it("should have no duplicate tool names", () => {
    const names = allTools.map((t) => t.name);
    const unique = new Set(names);
    assert.equal(
      names.length,
      unique.size,
      `Duplicate tool names found: ${names.filter((n, i) => names.indexOf(n) !== i).join(", ")}`,
    );
  });

  it("should have at least one tool", () => {
    assert.ok(allTools.length > 0);
  });

  for (const tool of allTools) {
    describe(tool.name, () => {
      it("should have a name prefixed with redis_", () => {
        assert.match(tool.name, /^redis_/);
      });

      it("should have a non-empty description", () => {
        assert.ok(tool.description.length > 0);
      });

      it("should have an input schema", () => {
        assert.ok(tool.inputSchema);
        assert.ok(typeof tool.inputSchema.shape === "object");
      });

      it("should have a handler function", () => {
        assert.equal(typeof tool.handler, "function");
      });

      it("should have annotations with required hints", () => {
        assert.ok(tool.annotations);
        assert.equal(typeof tool.annotations.readOnlyHint, "boolean");
        assert.equal(typeof tool.annotations.destructiveHint, "boolean");
        assert.equal(typeof tool.annotations.idempotentHint, "boolean");
        assert.equal(typeof tool.annotations.openWorldHint, "boolean");
      });
    });
  }
});
