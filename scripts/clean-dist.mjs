#!/usr/bin/env node
/**
 * Empty dist/ before a build.
 *
 * `tsc` writes into dist/ but never removes what it wrote before, so the
 * output of a deleted or renamed source file stays behind -- and the test
 * runner (scripts/run-tests.mjs) runs every *.test.js it finds there, so a
 * deleted test kept running against stale compiled code. Clearing dist/ first
 * makes the build a function of src/ alone.
 *
 * Resolved against this script's location, not the caller's cwd, so it can
 * only ever remove this repo's dist/.
 */

import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dist = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");
rmSync(dist, { recursive: true, force: true });
