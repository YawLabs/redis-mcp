/**
 * Bundles the MCP server into a single self-contained file.
 *
 * Why: `npx` has to install all runtime dependencies on every cold start.
 * With node_modules containing the MCP SDK, ioredis, and zod, this takes
 * minutes on Windows. By bundling everything into one file and declaring zero
 * runtime dependencies, npx downloads only the tarball and runs immediately.
 */

import { readFileSync } from "node:fs";
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/index.js",
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
  // Node built-ins are provided by the runtime.
  external: ["node:*"],
  // ioredis and its deps do `require("net")` / `require("tls")` etc. without
  // the `node:` prefix. In an ESM bundle that becomes a dynamic-require call
  // that fails at runtime. Inject a real `require` via createRequire so those
  // calls resolve against Node's built-in module loader.
  banner: {
    js: "import { createRequire as ___createRequire } from 'node:module'; const require = ___createRequire(import.meta.url);",
  },
  sourcemap: true,
  minify: false,
});
