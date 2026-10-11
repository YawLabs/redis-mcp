import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Resolve via import.meta.url so this works regardless of process.cwd(). The
// file lives one level below the repo root in both layouts -- src/ under vitest,
// dist/ for the compiled node:test run -- so the same hop reaches the root.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(repoRoot, rel), "utf-8")) as Record<string, unknown>;
}

describe("release metadata", () => {
  // server.json is what the Official MCP Registry reads at publish time. It
  // carries the version twice (top-level + packages[].version) and release.sh
  // bumps it separately from package.json. Without this, an edit that updates
  // one but not the other ships a desynced registry entry -- and the failure
  // only surfaces to users, never to the release.
  //
  // Ported from tailscale-mcp, which was the only server that had it. It earned
  // its keep immediately: it caught a version skew during the 0.15.0 release
  // that every other repo would have published silently.
  it("server.json top-level version matches package.json", () => {
    const pkg = readJson("package.json");
    const server = readJson("server.json");
    assert.equal(
      server.version,
      pkg.version,
      `server.json version (${String(server.version)}) must match package.json version (${String(pkg.version)})`,
    );
  });

  it("server.json packages[].version all match package.json", () => {
    const pkg = readJson("package.json");
    const server = readJson("server.json");
    const packages = server.packages as Array<{ version: string; identifier?: string }> | undefined;
    assert.ok(Array.isArray(packages) && packages.length > 0, "server.json must declare at least one package");
    for (const entry of packages ?? []) {
      assert.equal(
        entry.version,
        pkg.version,
        `server.json packages entry (${entry.identifier ?? "<unnamed>"}) version (${entry.version}) must match package.json version (${String(pkg.version)})`,
      );
    }
  });

  it("mcpName in package.json matches server.json name", () => {
    // A different drift mode: the registry keys the package by `name`, the npm
    // consumer reads `mcpName`. Disagreement puts discovery and install on
    // different identifiers.
    const pkg = readJson("package.json");
    const server = readJson("server.json");
    // Both must be present, or the equality below passes vacuously when a
    // refactor drops both fields.
    assert.ok(
      typeof pkg.mcpName === "string" && (pkg.mcpName as string).length > 0,
      "package.json must declare a non-empty `mcpName`",
    );
    assert.ok(
      typeof server.name === "string" && (server.name as string).length > 0,
      "server.json must declare a non-empty `name`",
    );
    assert.equal(pkg.mcpName, server.name, "package.json mcpName must equal server.json name");
  });
});

describe("server.json against the MCP Registry's field limits", () => {
  // The registry checks these at publish (step 7 of release.sh), which runs
  // AFTER the irreversible npm publish in step 5: a violation leaves the
  // version live on npm with no registry entry until a re-run. The numbers come
  // from the 2025-12-11 schema server.json declares; lengths are CODE POINTS,
  // which is what JSON Schema maxLength counts. release.sh runs the same check
  // in step 3, before the bump commit and tag. Ported from yaw-mcp's release.sh
  // guard.
  const pkg = readJson("package.json");
  const server = readJson("server.json");

  it("has a 1-100 code point description", () => {
    const length = typeof server.description === "string" ? [...server.description].length : -1;
    assert.ok(
      length >= 1 && length <= 100,
      `server.json description is ${length} code points; the registry allows 1-100`,
    );
  });

  it("has the registry name this repo publishes under, in the registry's pattern", () => {
    assert.equal(server.name, "io.github.YawLabs/redis-mcp");
    assert.match(String(server.name), /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    const length = [...String(server.name)].length;
    assert.ok(length >= 3 && length <= 200, `name is ${length} code points; the registry allows 3-200`);
  });

  it("declares the npm package by its package.json name, over stdio", () => {
    const packages = server.packages as Array<{ identifier?: string; transport?: { type?: string } }>;
    assert.equal(packages[0]?.identifier, pkg.name);
    assert.equal(packages[0]?.transport?.type, "stdio");
  });
});

describe("release.sh MCP Registry calls", () => {
  const releaseSh = readFileSync(resolve(repoRoot, "release.sh"), "utf-8");

  // mcp-publisher waits for the registry's answer with no limit of its own, so
  // release.sh runs each call to it -- every login and every publish attempt --
  // through mcp_bounded, its time limit. A call added or edited without it
  // would hang the release on a registry that never answers.
  it("runs every mcp-publisher login and publish through mcp_bounded", () => {
    const calls = releaseSh
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#") && /"\$MP" (login|publish)\b/.test(line));
    assert.ok(
      calls.filter((line) => line.includes('"$MP" login')).length >= 2,
      "release.sh: fewer than two mcp-publisher logins found -- has the call shape changed?",
    );
    assert.ok(
      calls.some((line) => line.includes('"$MP" publish')),
      "release.sh: no mcp-publisher publish found -- has the call shape changed?",
    );
    for (const line of calls) {
      assert.match(
        line,
        /mcp_bounded "\$MP" (login|publish)\b/,
        `release.sh runs mcp-publisher without its time limit: ${line.trim()}`,
      );
    }
  });

  // A first login the limit stopped is the registry not answering, not a bad
  // token: mcp_login_fail says so, where a bare fail would blame the token.
  it("fails a first login through mcp_login_fail", () => {
    assert.match(releaseSh, /^mcp_login_fail\(\) \{$/m);
    assert.match(releaseSh, /mcp_login_fail "mcp-publisher (OIDC )?login failed/);
    assert.doesNotMatch(releaseSh, /\bfail "mcp-publisher (OIDC )?login failed/);
    // The registry decides the namespace grant at login but refuses only at
    // publish, so a login failure that names a token scope blames something
    // that cannot cause it.
    assert.doesNotMatch(releaseSh, /mcp_login_fail "[^"]*read:org/);
  });

  // A proxy's refusal is matched right after the quoted URL, so a reason
  // phrase with a colon counts and a server's bytes echoed inside Go's quotes
  // do not; and a publish refused with a 403 gets its note, from a flag taken
  // before the publish log is removed.
  it("matches a proxy's refusal after the URL, and notes a 403 on publish", () => {
    assert.ok(releaseSh.includes('error sending request: [A-Z][a-z]+ "[^"]*": ('), "anchored proxy pattern");
    assert.match(releaseSh, /MCP_REFUSED_NAMESPACE=true; fi\n\s*rm -f "\$MCP_PUBLISH_LOG"/);
    assert.ok(releaseSh.includes("A 403 on publish is the registry refusing the io.github.YawLabs namespace"));
  });

  // The first mcp_bounded call sets the limit up; a flag inherited from the
  // environment must not stand in for that.
  it("sets the time limit up itself, whatever the environment carries", () => {
    assert.match(releaseSh, /^MCP_TIMEOUT_READY=""$/m);
  });
});
