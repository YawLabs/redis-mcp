import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Resolve via import.meta.url so this works regardless of process.cwd(). The
// compiled file lives in dist/, one level below the repo root, exactly like
// release-metadata.test.ts.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = resolve(REPO_ROOT, "dist", "index.js");

/**
 * Every top-level `await` in `source`, as "line:col: text". Top-level means not
 * inside any function body, where oam refuses a module: an `await` expression,
 * or a `for await` loop.
 *
 * A parse, not a grep: the bundle holds thousands of `await`s inside async
 * functions, and the one that broke oam sat mid-expression in a dead ternary
 * branch (`true ? "0.3.3" : (await null).createRequire(...)`), which no
 * line-shaped pattern separates from those.
 */
function topLevelAwaits(source: string, fileName = "index.js"): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    // A function boundary ends top level: an await below it is an ordinary one.
    if (ts.isFunctionLike(node)) return;
    const isAwait = ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier !== undefined);
    if (isAwait) {
      const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
      found.push(`${line + 1}:${character + 1}: ${node.getText(file).slice(0, 120)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe("built bundle", () => {
  // Controls first, so the real assertion below cannot pass vacuously -- a
  // walker that never recognises an await would report the bundle clean.
  it("control: the scan finds the shape that shipped, and ignores awaits inside functions", () => {
    const shipped = [
      'import { createRequire } from "node:module";',
      'var version2 = true ? "0.3.3" : (await null).createRequire(import.meta.url)("../package.json").version;',
      "for await (const x of []) {}",
    ].join("\n");
    assert.equal(topLevelAwaits(shipped).length, 2, "both top-level forms must be found");

    const nested = [
      'import { readFile } from "node:fs/promises";',
      'async function a() { return await readFile("x"); }',
      "const b = async () => { for await (const x of []) {} };",
      "class C { async m() { await null; } }",
    ].join("\n");
    assert.deepEqual(topLevelAwaits(nested), []);
  });

  // oam cannot `import()` a module with top-level await. The launcher serves
  // in-process by importing dist/index.js, so one such await made every
  // in-process fallback on an oam host print "fallback to Node failed" and set
  // exit code 1, even though the server went on to serve. The CJS
  // single-binary build (scripts/build-binary.mjs) cannot emit one either.
  it("dist/index.js has no top-level await", () => {
    assert.ok(existsSync(BUNDLE), `${BUNDLE} is not built -- run \`npm test\`, which builds first`);
    const found = topLevelAwaits(readFileSync(BUNDLE, "utf-8"));
    assert.deepEqual(found, [], `top-level await in dist/index.js:\n${found.join("\n")}`);
  });
});
