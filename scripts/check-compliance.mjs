#!/usr/bin/env node
// Grade the built server with @yawlabs/mcp-compliance, on each runtime the
// launcher can pick, before a release. Ported from aws-mcp's
// scripts/check-compliance.mjs.
//
// yaw-mcp grades every server it fronts with @yawlabs/mcp-compliance and can
// refuse to spawn one graded below its floor (YAW_MCP_MIN_COMPLIANCE), so this
// repo pins the same version line yaw-mcp grades with (devDependencies) and runs
// it here rather than finding out from a user's refused spawn. Bump the pin
// together with yaw-mcp's.
//
//   node scripts/check-compliance.mjs        both legs: REDIS_MCP_RUNTIME=node, then =oam
//
// The server exits at startup without REDIS_URL, so each leg points it at a
// plain-TCP RESP stub on 127.0.0.1 (dist/resp-fixture.js, built by `npm run
// build`): no Redis, no network. Each leg runs
// `mcp-compliance test --strict --min-grade A -- node bin/redis-mcp.mjs`, so the
// published launcher is what gets graded, and a required-test failure or a
// grade below A fails it.
//
// Exit status, which release.sh reads:
//   0  every leg ran and passed
//   1  a leg ran and failed
//   2  a leg could not run (the package is not installed, no oam on PATH for the
//      oam leg) -- printed as a WARNING naming what was skipped, never a silent
//      pass, and release.sh reports it as a warning rather than a green step.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(repoRoot, "bin", "redis-mcp.mjs");
const fixture = join(repoRoot, "dist", "resp-fixture.js");

function complianceBin() {
  // Read off disk, not require.resolve: the package's `exports` map does not
  // expose package.json, so resolving it throws ERR_PACKAGE_PATH_NOT_EXPORTED.
  const pkgPath = join(repoRoot, "node_modules", "@yawlabs", "mcp-compliance", "package.json");
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["mcp-compliance"];
    return rel ? { path: join(dirname(pkgPath), rel), version: pkg.version } : null;
  } catch {
    return null;
  }
}

function oamOnPath() {
  const r = spawnSync("oam", ["--version"], { encoding: "utf-8", windowsHide: true, timeout: 10_000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

const bin = complianceBin();
if (!bin) {
  console.warn("WARNING: @yawlabs/mcp-compliance is not installed (run npm ci); compliance was NOT checked.");
  process.exit(2);
}
for (const built of [join(repoRoot, "dist", "index.js"), fixture]) {
  if (!existsSync(built)) {
    console.error(`check-compliance: ${built} is missing -- run \`npm run build\` first.`);
    process.exit(1);
  }
}

const { startRespServer } = await import(pathToFileURL(fixture).href);
const redis = await startRespServer();

const skipped = [];
let failed = false;

try {
  for (const runtime of ["node", "oam"]) {
    if (runtime === "oam") {
      const oam = oamOnPath();
      if (!oam) {
        skipped.push("REDIS_MCP_RUNTIME=oam (no oam on PATH)");
        continue;
      }
      console.log(`\n=== mcp-compliance ${bin.version}, REDIS_MCP_RUNTIME=oam (${oam}) ===`);
    } else {
      console.log(`\n=== mcp-compliance ${bin.version}, REDIS_MCP_RUNTIME=node (${process.version}) ===`);
    }
    // spawnSync would block this process's event loop, and with it the RESP
    // stub the server under test is talking to -- so run the grader async.
    const status = await new Promise((done) => {
      import("node:child_process").then(({ spawn }) => {
        const child = spawn(
          process.execPath,
          [bin.path, "test", "--strict", "--min-grade", "A", "--", process.execPath, launcher],
          {
            cwd: repoRoot,
            stdio: "inherit",
            env: {
              ...process.env,
              REDIS_MCP_RUNTIME: runtime,
              REDIS_URL: `redis://127.0.0.1:${redis.port}`,
            },
            windowsHide: true,
          },
        );
        child.on("error", (err) => done(err.message));
        child.on("close", (code) => done(code));
      });
    });
    if (status !== 0) {
      console.error(`check-compliance: REDIS_MCP_RUNTIME=${runtime} failed (${typeof status === "number" ? `exit ${status}` : status})`);
      failed = true;
    }
  }
} finally {
  await redis.close();
}

if (failed) process.exit(1);
if (skipped.length > 0) {
  console.warn(`WARNING: compliance legs NOT run: ${skipped.join("; ")}`);
  process.exit(2);
}
console.log("\ncheck-compliance: every leg passed.");
