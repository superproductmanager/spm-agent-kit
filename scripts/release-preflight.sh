#!/usr/bin/env bash
# Checks that a release can start, before anything is built or tagged.
#
# Usage: scripts/release-preflight.sh <version> <mode>
#   <version>  the version without the leading v, for example 0.2.1
#   <mode>     dispatch: a manual start from the Actions tab (GITHUB_REF must be refs/heads/main,
#              and the tag v<version> must not exist locally or on origin yet)
#              tag: a tag push (only the version checks run)
#
# Exit codes: 0 all checks pass, 1 a check failed, 2 usage error.
# Reads README.md and RELEASE-NOTES.md from the repository root.
set -euo pipefail

die() {
  echo "release-preflight: $1" >&2
  exit 1
}

usage() {
  echo "release-preflight: usage: release-preflight.sh <version> <dispatch|tag>, for example 0.2.1 dispatch" >&2
  exit 2
}

VERSION="${1:-}"
MODE="${2:-}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || usage
case "$MODE" in
  dispatch|tag) ;;
  *) usage ;;
esac

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not inside a git repository"
cd "$ROOT"

# README says "Current version: <version>" inside a sentence. The version is digits and dots only (checked
# above), so escaping the dots makes it an exact pattern; it must not run on into a longer version (0.2.10).
VERSION_RE="${VERSION//./\\.}"
if ! grep -Eq -- "Current version: ${VERSION_RE}(\.?\$|\.?[^0-9.])" README.md 2>/dev/null; then
  die "README.md does not say 'Current version: $VERSION'"
fi

if ! grep -Fxq -- "## $VERSION" RELEASE-NOTES.md 2>/dev/null; then
  die "RELEASE-NOTES.md has no heading '## $VERSION'"
fi

if [ "$MODE" = "dispatch" ]; then
  if [ "${GITHUB_REF:-}" != "refs/heads/main" ]; then
    die "a manual release must run on refs/heads/main, not on '${GITHUB_REF:-}'"
  fi

  TAG="v$VERSION"
  if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
    die "tag $TAG already exists locally"
  fi

  # ls-remote --exit-code: 0 means the tag exists, 2 means it is absent, anything else means we could not ask.
  set +e
  git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1
  REMOTE_RC=$?
  set -e
  case "$REMOTE_RC" in
    0) die "tag $TAG already exists on origin" ;;
    2) ;;
    *) die "could not read tags from origin" ;;
  esac
fi

echo "release-preflight: all checks passed for $VERSION ($MODE)"
