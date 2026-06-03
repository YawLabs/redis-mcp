import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cursorSchema, keySchema, matchPatternSchema } from "./params.js";

describe("keySchema", () => {
  it("accepts ordinary keys", () => {
    assert.equal(keySchema.parse("user:1001"), "user:1001");
    assert.equal(keySchema.parse("session:abc-def"), "session:abc-def");
  });

  it("accepts multi-byte keys within the byte cap", () => {
    const k = "café:logs";
    assert.equal(keySchema.parse(k), k);
  });

  it("rejects empty keys", () => {
    assert.throws(() => keySchema.parse(""));
  });

  it("rejects keys over the 4096-byte cap", () => {
    assert.throws(() => keySchema.parse("a".repeat(4097)));
  });

  it("accepts a key at exactly 4096 bytes", () => {
    assert.equal(keySchema.parse("a".repeat(4096)).length, 4096);
  });
});

describe("matchPatternSchema", () => {
  it("accepts glob patterns", () => {
    assert.equal(matchPatternSchema.parse("user:*"), "user:*");
    assert.equal(matchPatternSchema.parse("session:??"), "session:??");
    assert.equal(matchPatternSchema.parse("*"), "*");
  });

  it("rejects empty pattern (use '*' for all)", () => {
    assert.throws(() => matchPatternSchema.parse(""));
  });
});

describe("cursorSchema", () => {
  it("defaults to '0'", () => {
    assert.equal(cursorSchema.parse(undefined), "0");
  });

  it("accepts a digit string (including very large 64-bit cursors)", () => {
    assert.equal(cursorSchema.parse("0"), "0");
    assert.equal(cursorSchema.parse("17592186044416"), "17592186044416");
    // Larger than Number.MAX_SAFE_INTEGER -- must stay a string, not be coerced.
    const big = "18446744073709551615";
    assert.equal(cursorSchema.parse(big), big);
  });

  it("rejects non-digit cursors", () => {
    assert.throws(() => cursorSchema.parse("abc"));
    assert.throws(() => cursorSchema.parse("-1"));
    assert.throws(() => cursorSchema.parse("1.5"));
  });
});
