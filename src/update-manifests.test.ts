import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// scripts/update-manifests.mjs writes package.json's description (and the
// homepage, version, license, URLs and command) into Ruby double-quoted strings
// in the Homebrew formula. These tests pin the escaping that keeps each value a
// plain string (CodeQL js/incomplete-sanitization).
//
// This file sits one level below the repo root both as src/ and as the
// compiled dist/, so the same hop reaches scripts/.
const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "update-manifests.mjs");

type Asset = { url: string; sha256: string };
type FormulaInput = {
  cmd: string;
  description?: string;
  homepage: string;
  version: string;
  license?: string;
  macArm64: Asset;
  macX64: Asset;
  linuxX64: Asset;
};

let rubyString: (value: unknown) => string;
let renderFormula: (input: FormulaInput) => string;
let formulaClassName: (cmd: string) => string;

before(async () => {
  // A computed specifier keeps tsc from resolving the untyped .mjs. Importing
  // it must not run the release side effects (gh release download, writes).
  const mod = (await import(pathToFileURL(scriptPath).href)) as {
    rubyString: typeof rubyString;
    renderFormula: typeof renderFormula;
    formulaClassName: typeof formulaClassName;
  };
  rubyString = mod.rubyString;
  renderFormula = mod.renderFormula;
  formulaClassName = mod.formulaClassName;
});

// Read the body of a Ruby double-quoted literal the way Ruby does, failing on
// anything that would end the string early or interpolate code.
function parseRubyDq(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\") {
      const next = body[++i];
      if (next === undefined) throw new Error("dangling backslash escapes the closing quote");
      out += next === "n" ? "\n" : next === "r" ? "\r" : next;
    } else if (c === '"') {
      throw new Error(`unescaped quote at ${i} ends the string early`);
    } else if (c === "#" && /[{@$]/.test(body[i + 1] ?? "")) {
      throw new Error(`unescaped interpolation at ${i}`);
    } else if (c === "\n" || c === "\r") {
      throw new Error(`raw line break at ${i}`);
    } else {
      out += c;
    }
  }
  return out;
}

const asset = (name: string): Asset => ({
  url: `https://github.com/YawLabs/redis-mcp/releases/download/v0.5.2/${name}`,
  sha256: "0".repeat(64),
});

function formulaFor(overrides: Partial<FormulaInput>): string {
  return renderFormula({
    cmd: "redis-mcp",
    description: "Redis MCP server",
    homepage: "https://yaw.sh/mcp-servers/redis-mcp/",
    version: "0.5.2",
    license: "MIT",
    macArm64: asset("redis-mcp-darwin-arm64"),
    macX64: asset("redis-mcp-darwin-x64"),
    linuxX64: asset("redis-mcp-linux-x64"),
    ...overrides,
  });
}

// The body of the `<stanza> "..."` line, from the opening quote to the end of
// the line -- deliberately NOT stopping at the first quote, so an escape that
// lets the string close early shows up as a parse failure.
function stanzaBody(formula: string, stanza: string): string {
  const line = formula.split("\n").find((l) => l.startsWith(`  ${stanza} "`));
  assert.ok(line, `formula has no ${stanza} line:\n${formula}`);
  assert.ok(line.endsWith('"'), `${stanza} line does not end in a quote: ${line}`);
  return line.slice(`  ${stanza} "`.length, -1);
}

describe("update-manifests rubyString", () => {
  const cases = [
    "Redis and Valkey MCP server, read-only by default: SCAN key exploration, TTL/memory inspection",
    'He said "hi"',
    "trailing backslash \\",
    'backslash then quote \\"',
    "C:\\path\\to\\thing",
    '#{system("rm -rf ~")}',
    "#@ivar and #$global",
    "line one\nline two\r\n",
    "",
  ];

  for (const input of cases) {
    it(`round-trips ${JSON.stringify(input)}`, () => {
      assert.equal(parseRubyDq(rubyString(input)), input);
    });
  }

  it("escapes the backslash before the quote", () => {
    // The old `.replace(/"/g, '\\"')` turned `\"` into `\\"`, which Ruby reads
    // as an escaped backslash followed by a closing quote.
    assert.equal(rubyString('a\\"b'), 'a\\\\\\"b');
  });

  it("escapes # only where it starts interpolation", () => {
    // brew style flags `\#` that is not followed by {, @ or $ as redundant.
    assert.equal(rubyString("C# support, issue #12"), "C# support, issue #12");
    assert.equal(rubyString("#{x} #@y #$z"), "\\#{x} \\#@y \\#$z");
  });

  it("treats null and undefined as empty", () => {
    assert.equal(rubyString(undefined), "");
    assert.equal(rubyString(null), "");
  });
});

describe("update-manifests renderFormula", () => {
  it("routes a hostile description through rubyString", () => {
    const hostile = 'Evil \\" desc #{system("touch /tmp/pwned")}\nend\nclass X';
    const formula = formulaFor({ description: hostile });
    assert.equal(stanzaBody(formula, "desc"), rubyString(hostile));
    assert.equal(parseRubyDq(stanzaBody(formula, "desc")), hostile);
    // The newline in the value must not have opened a new line of Ruby.
    assert.equal(formula.split("\n").filter((l) => l.startsWith("class ")).length, 1);
  });

  it("escapes homepage, version and license too", () => {
    const formula = formulaFor({ homepage: 'https://x/"#{1}', version: '1"2', license: 'MIT"#$x' });
    assert.equal(parseRubyDq(stanzaBody(formula, "homepage")), 'https://x/"#{1}');
    assert.equal(parseRubyDq(stanzaBody(formula, "version")), '1"2');
    assert.equal(parseRubyDq(stanzaBody(formula, "license")), 'MIT"#$x');
  });

  it("keeps the brew interpolation in the test block", () => {
    const formula = formulaFor({});
    assert.match(formula, /shell_output\("#\{bin\}\/redis-mcp --version"\)/);
    assert.match(formula, /bin\.install Dir\["\*"\]\.first => "redis-mcp"/);
  });

  it("uses :cannot_represent for a proprietary license", () => {
    assert.match(formulaFor({ license: "UNLICENSED" }), /^ {2}license :cannot_represent$/m);
    assert.match(formulaFor({ license: undefined }), /^ {2}license :cannot_represent$/m);
  });

  it("refuses a command that is not a valid class name", () => {
    assert.equal(formulaClassName("redis-mcp"), "RedisMcp");
    assert.throws(() => formulaClassName("redis mcp;"), /valid Homebrew class name/);
    assert.throws(() => formulaClassName("9lives"), /valid Homebrew class name/);
  });
});
