#!/bin/sh
# RHEA-192 m17: the version every dropit build reports (/api/version, 管理 → 更新, image label).
# It is the newest vX.Y.Z git tag plus the number of commits since that tag:
#   on the tag itself      -> 0.1.0
#   20 commits after it    -> 0.1.0+20
# The commit hash is reported next to it separately. Cutting a release = pushing a new tag (git tag v0.2.0).
# Without git history (a tarball, a Docker build context) it falls back to the root package.json version.
# Used by CI (.github/workflows/ci.yml), scripts/update.sh and apps/server/scripts/build-info.mjs.
cd "$(dirname "$0")/.." || exit 1
if described=$(git describe --tags --long --match 'v[0-9]*' 2>/dev/null); then
  printf '%s\n' "$described" | sed -E 's/^v([0-9]+\.[0-9]+\.[0-9]+([-][0-9A-Za-z.]+)?)-([0-9]+)-g[0-9a-f]+$/\1+\3/; s/\+0$//'
  exit 0
fi
version=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' package.json 2>/dev/null | head -n 1)
printf '%s\n' "${version:-0.0.0}"
