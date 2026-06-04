#!/usr/bin/env node
/**
 * Cross-platform test runner. Passing a directory to `node --test` hangs on
 * Windows (works on Linux) and globs like `dist/**\/*.test.js` only expand
 * in bash with globstar - PowerShell leaves them as literal paths. This
 * script enumerates test files with Node's stdlib and passes explicit paths.
 *
 * Usage:
 *   node scripts/run-tests.mjs [dir]        - all *.test.js under dir
 *   node scripts/run-tests.mjs [dir] --integration  - only *.integration.test.js, serialized
 */

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const integrationOnly = args.includes("--integration");
const dir = resolve(args.find((a) => !a.startsWith("--")) ?? "dist");

const allFiles = readdirSync(dir, { recursive: true, encoding: "utf-8" })
  .filter((f) => f.endsWith(".test.js"))
  .map((f) => join(dir, f));

const files = integrationOnly ? allFiles.filter((f) => f.includes(".integration.")) : allFiles;

if (files.length === 0) {
  // No integration tests exist yet (none are committed). A `--integration`
  // run with zero matches is the expected state, not a failure -- no-op
  // cleanly so the script can stay wired up for when they land. A plain
  // unit run finding zero files IS a broken build, so that stays fatal.
  if (integrationOnly) {
    console.log("No integration test files found (--integration filter) -- nothing to run.");
    process.exit(0);
  }
  console.error(`No test files found in ${dir}`);
  process.exit(1);
}

// Always serialize. Integration files race on the shared keyspace; unit files
// mutate `process.env` (ALLOW_WRITES, REDIS_MAX_KEYS, ...) which is
// process-wide, so parallel files flap on env values written by another file.
const nodeArgs = ["--test", "--test-concurrency=1", ...files];

const child = spawn(process.execPath, nodeArgs, { stdio: "inherit" });
child.on("exit", (code) => {
  // On a plain unit run, the *.integration.test.js suites either aren't in
  // `files` (filtered out) or load and SKIP when REDIS_URL is unset -- and
  // node:test reports "# skipped 0" for a file that self-skips, so the inert
  // integration tier is otherwise invisible. Print an explicit note so the
  // gap is obvious.
  if (!integrationOnly) {
    const integrationCount = allFiles.filter((f) => f.includes(".integration.")).length;
    if (integrationCount > 0) {
      console.log(
        `Note: ${integrationCount} integration test file(s) require REDIS_URL + ` +
          "`npm run test:integration` to execute (skipped here).",
      );
    }
  }
  process.exit(code ?? 1);
});
