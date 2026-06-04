#!/bin/bash
# =============================================================================
# Post-publish smoke test
# =============================================================================
# Exercise the published tarball end to end: pull @yawlabs/redis-mcp@<version>
# straight from npm via `npx -y` and assert its `version` subcommand reports the
# exact version we just published. This catches problems `npm view` (registry
# metadata only) misses -- an uninstallable tarball, a broken bin shebang, a
# version mismatch baked into the bundle, or a CDN edge serving a stale artifact.
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

# Run the published bin's `version` subcommand. Capture stdout only; trim
# surrounding whitespace/newlines so the equality check isn't tripped by a
# trailing newline.
RAW=$(npx -y "@yawlabs/redis-mcp@${VERSION}" version)
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
