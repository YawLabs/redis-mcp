/**
 * Unit tests for the exported `pickReply` helper. These run WITHOUT a live
 * Redis (no REDIS_URL needed) -- pickReply is pure, operating on the
 * `[Error | null, unknown][] | null` shape that ioredis pipeline.exec()
 * resolves to. The io-boundary handlers that consume it live in the
 * integration suite (keyspace.integration.test.ts).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { shutdown } from "../api.js";
import { toMcpResponse } from "../mcp-response.js";
import { bulk, int, type RespServer, startRespServer } from "../resp-fixture.js";
import { keyspaceTools, pickReply } from "./keyspace.js";

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

describe("redis_get field order", () => {
  // A host that caps a tool result cuts the END of the text block: Yaw MCP
  // keeps the first YAW_MCP_MAX_RESULT_BYTES (100,000 by default) and drops
  // the rest, below this server's 256 KiB REDIS_MAX_VALUE_BYTES default. With
  // the payload first, that cut took `length` and `truncated` -- the fields
  // that say the value was cut -- and left a value that looked whole. The
  // metadata now precedes the payload in every branch, pinned here against a
  // RESP stub so no live Redis is needed.
  const redisGet = keyspaceTools.find((tool) => tool.name === "redis_get");
  const big = "x".repeat(300_000);
  const savedUrl = process.env.REDIS_URL;
  let server: RespServer | null = null;

  before(async () => {
    server = await startRespServer({
      TYPE: () => "+string\r\n",
      STRLEN: () => int(big.length),
      GETRANGE: (args) => bulk(big.slice(0, Number(args[2]) + 1)),
    });
    process.env.REDIS_URL = `redis://127.0.0.1:${server.port}`;
  });

  after(async () => {
    await shutdown();
    await server?.close();
    if (savedUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = savedUrl;
  });

  it("puts length and truncated before the string value", async () => {
    assert.ok(redisGet, "redis_get is registered");
    const result = (await redisGet.handler({ key: "k" })) as { ok: boolean; data: Record<string, unknown> };
    assert.equal(result.ok, true, JSON.stringify(result).slice(0, 300));
    assert.deepEqual(Object.keys(result.data), ["key", "type", "length", "truncated", "value"]);
    assert.equal(result.data.truncated, true);
    // What a 100,000-byte cut of the rendered reply still carries.
    const head = toMcpResponse(result).content[0]?.text.slice(0, 100_000) ?? "";
    assert.match(head, /"truncated": true/);
    assert.match(head, /"length": 300000/);
  });

  it("puts the size and truncated before the payload in every collection branch", () => {
    // The collection branches need more RESP than this stub speaks, so read
    // the order off the source: each `data:` object must name `truncated`
    // before its payload field.
    const source = readFileSync(fileURLToPath(new URL("../../src/tools/keyspace.ts", import.meta.url)), "utf8");
    const objects = [...source.matchAll(/data: \{ key, type, ([^}]*)\}/g)].map((m) => m[1] ?? "");
    assert.ok(objects.length >= 6, `expected six redis_get data objects, found ${objects.length}`);
    for (const fields of objects) {
      const names = fields.split(",").map((f) => f.trim().split(":")[0]);
      const t = names.indexOf("truncated");
      assert.ok(t !== -1, fields);
      assert.equal(t, names.length - 2, `truncated must sit just before the payload: ${fields}`);
    }
  });
});
