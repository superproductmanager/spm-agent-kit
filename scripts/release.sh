#!/usr/bin/env bash
# Builds the release archive for one version, from its tag.
#
# Usage: scripts/release.sh <version>      for example: scripts/release.sh 0.1.0
#
# Needs: a clean working tree, the tag v<version>, and HEAD at that tag.
# Writes: dist/spm-agent-kit-<version>.tar.gz and dist/SHA256SUMS
# The archive holds the files as they are in the tag, under one folder spm-agent-kit-<version>/.
set -euo pipefail

die() {
  echo "release: $1" >&2
  exit 1
}

VERSION="${1:-}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "usage: release.sh <version>, for example 0.1.0"

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not inside a git repository"
cd "$ROOT"

[ -z "$(git status --porcelain)" ] || die "the working tree is not clean; commit or remove changes first"

TAG="v$VERSION"
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || die "there is no tag $TAG"
[ "$(git rev-parse HEAD)" = "$(git rev-list -n 1 "$TAG")" ] || die "HEAD is not at $TAG; check out the tag first"

ARCHIVE="spm-agent-kit-$VERSION.tar.gz"
mkdir -p dist
git archive --format=tar --prefix="spm-agent-kit-$VERSION/" "$TAG" | gzip -n > "dist/$ARCHIVE"
(cd dist && sha256sum "$ARCHIVE" > SHA256SUMS)

echo "release: built dist/$ARCHIVE"
echo "release: checksums in dist/SHA256SUMS"
