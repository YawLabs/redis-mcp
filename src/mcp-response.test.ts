import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toMcpResponse } from "./mcp-response.js";

describe("toMcpResponse", () => {
  it("maps ok:true with data to a JSON text block, no isError", () => {
    const r = toMcpResponse({ ok: true, data: { keys: ["a", "b"], count: 2 } });
    assert.equal(r.isError, undefined);
    assert.equal(r.content.length, 1);
    assert.equal(r.content[0]!.type, "text");
    assert.deepEqual(JSON.parse(r.content[0]!.text), { keys: ["a", "b"], count: 2 });
  });

  it("defaults to { success: true } when ok:true but data is undefined", () => {
    const r = toMcpResponse({ ok: true });
    assert.deepEqual(JSON.parse(r.content[0]!.text), { success: true });
    assert.equal(r.isError, undefined);
  });

  it("maps ok:false with an error message to an isError text block", () => {
    const r = toMcpResponse({ ok: false, error: "WRONGTYPE Operation against a key holding the wrong kind of value" });
    assert.equal(r.isError, true);
    assert.equal(r.content[0]!.text, "Error: WRONGTYPE Operation against a key holding the wrong kind of value");
  });

  it("falls back to 'Unknown error' when ok:false and error is missing", () => {
    const r = toMcpResponse({ ok: false });
    assert.equal(r.isError, true);
    assert.equal(r.content[0]!.text, "Error: Unknown error");
  });

  it("pretty-prints data with 2-space indentation (readable in the client)", () => {
    const r = toMcpResponse({ ok: true, data: { a: 1 } });
    assert.ok(r.content[0]!.text.includes("\n  "), "expected indented JSON");
  });
});
