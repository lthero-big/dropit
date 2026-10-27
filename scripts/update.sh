#!/usr/bin/env bash
# Update a dropit git checkout to the latest commit of its branch and restart it.
#
#   ./scripts/update.sh            source install: git pull, pnpm install, pnpm build, restart
#   ./scripts/update.sh --docker   compose build from source: git pull, docker compose up -d --build
#   ./scripts/update.sh --check    only report whether the checkout is behind its upstream
#
# Restart (source mode): $DROPIT_RESTART_CMD if set, else `systemctl restart dropit` when that
# unit exists, else `pm2 restart dropit` when that pm2 app exists, else prints what to run.
# FORCE=1 rebuilds even when git reports nothing new.
set -euo pipefail

mode=source
case "${1:-}" in
  "") ;;
  --docker) mode=docker ;;
  --check) mode=check ;;
  -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
  *) echo "Unknown option: $1 (use --docker, --check or --help)" >&2; exit 2 ;;
esac

cd "$(dirname "$0")/.."
command -v git >/dev/null || { echo "git is required" >&2; exit 1; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "$(pwd) is not a git checkout" >&2; exit 1; }

before=$(git rev-parse --short=7 HEAD)
if [ "$mode" = check ]; then
  git fetch --quiet
  behind=$(git rev-list --count "HEAD..@{upstream}")
  echo "current $before, upstream $(git rev-parse --short=7 '@{upstream}'), behind by $behind"
  exit 0
fi

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Tracked files have local changes; commit or stash them first (update uses git pull --ff-only)." >&2
  exit 1
fi

echo "==> git pull --ff-only"
git pull --ff-only
after=$(git rev-parse --short=7 HEAD)
if [ "$before" = "$after" ] && [ "${FORCE:-0}" != 1 ]; then
  echo "Already up to date ($after). Use FORCE=1 to rebuild anyway."
  exit 0
fi
echo "==> $before -> $after"

export DROPIT_COMMIT="$after"
DROPIT_BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
export DROPIT_BUILD_DATE

if [ "$mode" = docker ]; then
  echo "==> docker compose up -d --build"
  docker compose up -d --build
  echo "Updated to $after."
  exit 0
fi

command -v pnpm >/dev/null || { echo "pnpm is required (corepack enable)" >&2; exit 1; }
echo "==> pnpm install --frozen-lockfile"
pnpm install --frozen-lockfile
echo "==> pnpm build"
pnpm build

if [ -n "${DROPIT_RESTART_CMD:-}" ]; then
  echo "==> $DROPIT_RESTART_CMD"
  sh -c "$DROPIT_RESTART_CMD"
elif command -v systemctl >/dev/null && systemctl cat dropit.service >/dev/null 2>&1; then
  echo "==> systemctl restart dropit"
  systemctl restart dropit
elif command -v pm2 >/dev/null && pm2 describe dropit >/dev/null 2>&1; then
  echo "==> pm2 restart dropit"
  pm2 restart dropit
else
  echo "Built $after. Restart the server now, e.g. NODE_ENV=production pnpm --filter @dropit/server start"
  echo "(set DROPIT_RESTART_CMD to let this script do it)."
  exit 0
fi
echo "Updated to $after."
