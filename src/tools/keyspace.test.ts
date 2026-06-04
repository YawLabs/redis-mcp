/**
 * Unit tests for the exported `pickReply` helper. These run WITHOUT a live
 * Redis (no REDIS_URL needed) -- pickReply is pure, operating on the
 * `[Error | null, unknown][] | null` shape that ioredis pipeline.exec()
 * resolves to. The io-boundary handlers that consume it live in the
 * integration suite (keyspace.integration.test.ts).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pickReply } from "./keyspace.js";

describe("pickReply", () => {
  it("returns null when replies is null", () => {
    assert.equal(pickReply<string>(null, 0), null);
  });

  it("returns null when replies is empty (index has no tuple)", () => {
    assert.equal(pickReply<string>([], 0), null);
  });

  it("returns null when the index is out of range", () => {
    const replies: [Error | null, unknown][] = [[null, "a"]];
    assert.equal(pickReply<string>(replies, 5), null);
  });

  it("returns null when the tuple's error slot is non-null", () => {
    const replies: [Error | null, unknown][] = [[new Error("MEMORY USAGE unsupported"), "ignored"]];
    assert.equal(pickReply<string>(replies, 0), null);
  });

  it("returns the value when the error slot is null", () => {
    const replies: [Error | null, unknown][] = [[null, "hello"]];
    assert.equal(pickReply<string>(replies, 0), "hello");
  });

  it("picks the value at the requested index, not the first", () => {
    const replies: [Error | null, unknown][] = [
      [null, "zero"],
      [null, 42],
      [null, "two"],
    ];
    assert.equal(pickReply<number>(replies, 1), 42);
    assert.equal(pickReply<string>(replies, 2), "two");
  });
});
