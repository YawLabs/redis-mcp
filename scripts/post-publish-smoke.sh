#!/bin/bash
# =============================================================================
# Post-publish smoke test
# =============================================================================
# Exercise the published tarball end to end. `npm view` in the release
# script only checks the registry metadata, which can show the right version
# even when the tarball or its bundle is broken -- so this script downloads
# the actual tarball, extracts it to a temp dir, and runs the entry script's
# `version` subcommand. A version mismatch, broken bundle, or a non-
# executable entry would all fail here even though `npm view` looks fine.
#
# Why `npm pack` + `node ./dist/index.js` instead of `npx -y`:
#   `npx -y <pkg> version` works on macOS/Linux: the package's `bin` shim
#   is added to `~/.npm/_npx/` and npx invokes it directly. On Windows
#   under Git Bash / `cmd`, the same invocation shells out to `cmd` to
#   resolve the bin name; if the shim isn't on `PATH` (common in fresh
#   sessions and CI), cmd returns
#     `'redis-mcp' is not recognized as an internal or external command`
#   and the smoke fails even when the tarball is correct. `npm pack` +
#   direct `node` invocation bypasses the bin-resolution step entirely
#   and is portable across all three platforms.
#
# Usage: ./scripts/post-publish-smoke.sh <version>
# =============================================================================

set -euo pipefail

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "[X] post-publish-smoke: missing required <version> argument" >&2
  echo "    usage: ./scripts/post-publish-smoke.sh <version>" >&2
  exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Download the tarball straight from the registry. Equivalent to
# `npm pack @yawlabs/redis-mcp@${VERSION}` but without writing a copy
# into the current directory.
npm pack "@yawlabs/redis-mcp@${VERSION}" --pack-destination="$TMP" >/dev/null

# npm pack writes one or more .tgz files; the filename uses the unscoped
# package name with a slash replaced by a dash. Pick the only .tgz in
# the temp dir.
TARBALL=$(find "$TMP" -maxdepth 1 -name '*.tgz' | head -n 1)
if [ -z "$TARBALL" ]; then
  echo "[X] post-publish-smoke: npm pack produced no tarball for @yawlabs/redis-mcp@${VERSION}" >&2
  exit 1
fi

# Extract into a subdir so node_modules / package contents don't pollute
# the temp dir root.
EXTRACT="$TMP/extracted"
mkdir -p "$EXTRACT"
tar xzf "$TARBALL" -C "$EXTRACT"

# The bundle ships as a single self-contained dist/index.js (zero runtime
# deps per the build.mjs bundle config). The entry script's first lines
# check `process.argv[2]` and short-circuit to a `version` print when it
# matches, so we just need to invoke node against it.
ENTRY="$EXTRACT/package/dist/index.js"
if [ ! -f "$ENTRY" ]; then
  echo "[X] post-publish-smoke: tarball missing expected entry dist/index.js" >&2
  exit 1
fi

# Run the published entry's `version` subcommand. Capture stdout only;
# trim surrounding whitespace/newlines so the equality check isn't tripped
# by a trailing newline.
RAW=$(node "$ENTRY" version 2>/dev/null || true)
REPORTED=$(printf '%s' "$RAW" | tr -d '[:space:]')

if [ "$REPORTED" = "$VERSION" ]; then
  echo "[OK] post-publish-smoke: @yawlabs/redis-mcp@${VERSION} reports version '${REPORTED}'"
  exit 0
fi

echo "[X] post-publish-smoke: version mismatch for @yawlabs/redis-mcp@${VERSION}" >&2
echo "    expected: '${VERSION}'" >&2
echo "    reported: '${REPORTED}'" >&2
echo "    raw output: '${RAW}'" >&2
exit 1
