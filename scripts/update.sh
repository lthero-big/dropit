#!/usr/bin/env bash
# Update a dropit git checkout to the latest commit of its branch and restart it.
#
#   ./scripts/update.sh                 source install: git pull, pnpm install, pnpm build, restart
#   ./scripts/update.sh --docker        compose build from source: git pull, rebuild, restart
#   ./scripts/update.sh --check         only report whether the checkout is behind its upstream
#
# Docker options (each implies --docker):
#   --compose-file FILE   compose file to use (repeatable). Default: the files the running dropit
#                         container was started with (compose labels), else $COMPOSE_FILE, else
#                         docker-compose.yml.
#   -p, --project-name N  compose project name (default: the running container's project).
#   --dry-run             fetch only, print the plan and run the safety checks, change nothing.
#   --no-backup           skip the pre-update backup of the data volume.
# Env: FORCE=1 rebuilds even when git reports nothing new; DROPIT_BACKUP_DIR (default
# ~/dropit-backups); DROPIT_SERVICE (default dropit); DROPIT_UPDATE_TIMEOUT seconds (default 120);
# ALLOW_VOLUME_CHANGE=1 lets an update move /data to a different volume (normally refused).
#
# Restart (source mode): $DROPIT_RESTART_CMD if set, else `systemctl restart dropit` when that
# unit exists, else `pm2 restart dropit` when that pm2 app exists, else prints what to run.
set -euo pipefail

mode=source
dry_run=0
backup=1
compose_files=()
project=""
usage() { sed -n '2,20p' "$0"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --docker) mode=docker ;;
    --check) mode=check ;;
    --compose-file) [ $# -ge 2 ] || { echo "--compose-file needs a file" >&2; exit 2; }
      compose_files+=("$2"); mode=docker; shift ;;
    --compose-file=*) compose_files+=("${1#*=}"); mode=docker ;;
    -p|--project-name) [ $# -ge 2 ] || { echo "$1 needs a name" >&2; exit 2; }
      project="$2"; mode=docker; shift ;;
    --project-name=*) project="${1#*=}"; mode=docker ;;
    --dry-run) dry_run=1 ;;
    --no-backup) backup=0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

cd "$(dirname "$0")/.."
repo=$(pwd -P)
command -v git >/dev/null || { echo "git is required" >&2; exit 1; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "$repo is not a git checkout" >&2; exit 1; }

before=$(git rev-parse --short=7 HEAD)
if [ "$mode" = check ]; then
  git fetch --quiet
  behind=$(git rev-list --count "HEAD..@{upstream}")
  echo "current $before, upstream $(git rev-parse --short=7 '@{upstream}'), behind by $behind"
  exit 0
fi

die() { echo "update.sh: $*" >&2; exit 1; }
service=${DROPIT_SERVICE:-dropit}

# ---------------------------------------------------------------- docker helpers
# Print "<type>:<name or path>" of the mount at /data of container $1.
container_data() {
  docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Type}}:{{if eq .Type "volume"}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}' "$1"
}
label() { docker inspect -f "{{index .Config.Labels \"$2\"}}" "$1"; }

# The dropit container this checkout is currently running (running ones first), if any.
find_current() {
  local id
  for flag in "" "-a"; do
    # shellcheck disable=SC2086
    id=$(docker ps $flag -q --filter "label=com.docker.compose.project.working_dir=$repo" \
      --filter "label=com.docker.compose.service=$service" | head -n1)
    [ -n "$id" ] && { echo "$id"; return; }
  done
  # Containers started by hand (docker run --name dropit) carry no compose labels.
  docker ps -a -q --filter "name=^/dropit$" | head -n1
}

# Read project name, image and /data mount of the target compose config (JSON on stdin).
# Needs one of jq, python3 or node.
compose_facts() {
  local json; json=$(cat)
  if command -v jq >/dev/null; then
    printf '%s' "$json" | jq -r --arg s "$service" '
      . as $r | "name=\(.name)",
      "image=\(.services[$s].image // "")",
      "data=\(([.services[$s].volumes[]? | select(.target=="/data")
        | if .type=="volume" then "volume:" + ($r.volumes[.source].name // .source)
          else .type + ":" + .source end] | first) // "")"'
  elif command -v python3 >/dev/null; then
    printf '%s' "$json" | python3 -c '
import json, sys
r = json.load(sys.stdin); s = r.get("services", {}).get(sys.argv[1], {})
d = ""
for v in s.get("volumes", []):
    if v.get("target") == "/data":
        d = ("volume:" + (r.get("volumes", {}).get(v["source"], {}).get("name") or v["source"])) if v.get("type") == "volume" else v.get("type") + ":" + v.get("source", "")
        break
print("name=" + r.get("name", "")); print("image=" + (s.get("image") or "")); print("data=" + d)' "$service"
  elif command -v node >/dev/null; then
    printf '%s' "$json" | node -e '
let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{const r=JSON.parse(b),s=(r.services||{})[process.argv[1]]||{};
const v=(s.volumes||[]).find(v=>v.target==="/data");let d="";
if(v)d=v.type==="volume"?"volume:"+(((r.volumes||{})[v.source]||{}).name||v.source):v.type+":"+v.source;
console.log("name="+(r.name||""));console.log("image="+(s.image||""));console.log("data="+d)})' "$service"
  else
    die "need jq, python3 or node to read the compose config (or install one of them)"
  fi
}

# Run node inside container $1 (CommonJS, cwd /app so better-sqlite3 resolves).
cnode() { docker exec -w /app "$1" node -e "$2"; }
count_users() {
  cnode "$1" "const D=require('better-sqlite3');const db=new D(require('path').join(process.env.DATA_DIR||'/data','dropit.sqlite'),{readonly:true});console.log(db.prepare('select count(*) c from users').get().c)" 2>/dev/null || echo unknown
}
app_get() {
  cnode "$1" "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'$2').then(async r=>{if(!r.ok)process.exit(1);process.stdout.write(await r.text())}).catch(()=>process.exit(1))" 2>/dev/null
}

# Resolve the target compose config and refuse to switch /data to another volume.
resolve_and_check() {
  config=$("${compose[@]}" config --format json) || die "docker compose config failed for: ${compose[*]}"
  facts=$(printf '%s' "$config" | compose_facts)
  t_project=$(sed -n 's/^name=//p' <<<"$facts")
  t_image=$(sed -n 's/^image=//p' <<<"$facts")
  t_data=$(sed -n 's/^data=//p' <<<"$facts")
  # Without an image: key compose names the built image <project>-<service>.
  t_image=${t_image:-$t_project-$service}
  [ -n "$t_data" ] || die "service '$service' in ${compose[*]} has no /data mount; refusing (set DROPIT_SERVICE?)"
  [ "${1:-}" = quiet ] || echo "==> compose: ${compose[*]} (from $source_of_files), project $t_project, service $service"
  [ "${1:-}" = quiet ] || echo "    data: $t_data, image: $t_image"

  # The container compose is about to replace (same project + service), if any.
  replaced=$(docker ps -a -q --filter "label=com.docker.compose.project=$t_project" \
    --filter "label=com.docker.compose.service=$service" | head -n1)

  # Safety: never switch the live deployment to a different (usually brand-new, empty) volume.
  for c in $current $replaced; do
    c_data=$(container_data "$c")
    c_name=$(docker inspect -f '{{.Name}}' "$c" | sed 's#^/##')
    if [ -n "$c_data" ] && [ "$c_data" != "$t_data" ] && [ "${ALLOW_VOLUME_CHANGE:-0}" != 1 ]; then
      c_files=$(label "$c" com.docker.compose.project.config_files)
      {
        echo "update.sh: REFUSING: container '$c_name' uses /data = $c_data,"
        echo "  but ${compose[*]} would start '$service' with /data = $t_data."
        echo "  That is a different volume, so the instance would come up empty."
        if [ -n "$c_files" ] && [ "$c_files" != "<no value>" ]; then
          echo "  '$c_name' was deployed with: $c_files"
          echo "  Run:  ./scripts/update.sh --compose-file ${c_files%%,*}"
        fi
        echo "  (ALLOW_VOLUME_CHANGE=1 overrides this check if the switch is intended.)"
      } >&2
      exit 1
    fi
  done
  if [ -z "$current$replaced" ] && [ "${t_data%%:*}" = volume ] && [ "${ALLOW_VOLUME_CHANGE:-0}" != 1 ] \
     && ! docker volume inspect "${t_data#volume:}" >/dev/null 2>&1; then
    others=$(docker volume ls -q | grep -E '(^|_)dropit-data$' || true)
    if [ -n "$others" ]; then
      die "no dropit container found for this checkout, $t_data does not exist yet, but these dropit volumes do: $(echo "$others" | tr '\n' ' ')- pass the right --compose-file, or ALLOW_VOLUME_CHANGE=1 to create a new empty volume."
    fi
  fi
}

# ---------------------------------------------------------------- docker: resolve the deployment
if [ "$mode" = docker ]; then
  command -v docker >/dev/null || die "docker is required"
  docker compose version >/dev/null 2>&1 || die "docker compose v2 is required"
  current=$(find_current || true)
  source_of_files="--compose-file"
  if [ ${#compose_files[@]} -eq 0 ] && [ -n "${COMPOSE_FILE:-}" ]; then
    source_of_files="COMPOSE_FILE"
  elif [ ${#compose_files[@]} -eq 0 ] && [ -n "$current" ]; then
    cf=$(label "$current" com.docker.compose.project.config_files)
    if [ -n "$cf" ] && [ "$cf" != "<no value>" ]; then
      IFS=',' read -r -a compose_files <<<"$cf"
      source_of_files="running container $(docker inspect -f '{{.Name}}' "$current" | sed 's#^/##')"
      if [ -z "$project" ]; then project=$(label "$current" com.docker.compose.project); fi
    fi
  fi
  if [ ${#compose_files[@]} -eq 0 ] && [ -z "${COMPOSE_FILE:-}" ]; then source_of_files="default"; fi
  for f in "${compose_files[@]}"; do [ -f "$f" ] || die "compose file not found: $f"; done
  compose=(docker compose)
  for f in "${compose_files[@]}"; do compose+=(-f "$f"); done
  [ -n "$project" ] && compose+=(-p "$project")
  # Check before touching the checkout; checked again after the pull (compose files may change).
  resolve_and_check
fi

# ---------------------------------------------------------------- git
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  die "tracked files have local changes; commit or stash them first (update uses git pull --ff-only)."
fi

if [ "$dry_run" = 1 ]; then
  git fetch --quiet
  after=$(git rev-parse --short=7 '@{upstream}')
  echo "==> dry run: would update $before -> $after ($(git rev-list --count "HEAD..@{upstream}") commits)"
  [ "$mode" = docker ] || exit 0
else
  echo "==> git pull --ff-only"
  git pull --ff-only
  after=$(git rev-parse --short=7 HEAD)
  if [ "$before" = "$after" ] && [ "${FORCE:-0}" != 1 ]; then
    echo "Already up to date ($after). Use FORCE=1 to rebuild anyway."
    exit 0
  fi
  echo "==> $before -> $after"
fi

DROPIT_COMMIT="$after"
DROPIT_BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
export DROPIT_COMMIT DROPIT_BUILD_DATE

if [ "$mode" = docker ]; then
  [ "$dry_run" = 1 ] || resolve_and_check quiet
  live=""
  [ -n "$current" ] && live=$current
  [ -z "$live" ] && [ -n "$replaced" ] && live=$replaced
  users_before=unknown
  if [ -n "$live" ] && [ "$(docker inspect -f '{{.State.Running}}' "$live")" = true ]; then
    users_before=$(count_users "$live")
  fi
  echo "    current container: ${live:-none}, users: $users_before"

  if [ "$dry_run" = 1 ]; then
    echo "==> dry run OK: checks passed, nothing changed."
    exit 0
  fi

  stamp=$(date -u +%Y%m%d-%H%M%S)
  old_image=""
  if [ -n "$live" ]; then
    old_image=$(docker inspect -f '{{.Image}}' "$live")
    if [ -n "$t_image" ]; then
      rollback_tag="${t_image%:*}:pre-update-$before-$stamp"
      [[ "$t_image" == *:* ]] || rollback_tag="$t_image:pre-update-$before-$stamp"
      docker tag "$old_image" "$rollback_tag"
      echo "==> rollback image: $rollback_tag"
    fi
  fi

  backup_file=""
  if [ "$backup" = 1 ] && [ -n "$live" ]; then
    bdir=${DROPIT_BACKUP_DIR:-$HOME/dropit-backups}
    mkdir -p "$bdir"; bdir=$(cd "$bdir" && pwd -P)
    backup_file="$bdir/dropit-data-$before-$stamp.tgz"
    src=${t_data#*:}
    echo "==> backup /data -> $backup_file"
    running=$(docker inspect -f '{{.State.Running}}' "$live")
    if [ "$running" = true ]; then
      # Consistent copy of the live database through the SQLite backup API; uploads are
      # immutable files and are copied as they are.
      cnode "$live" "const D=require('better-sqlite3'),p=require('path'),d=process.env.DATA_DIR||'/data';new D(p.join(d,'dropit.sqlite'),{readonly:true}).backup(p.join(d,'.update-backup.sqlite')).then(()=>process.exit(0),e=>{console.error(e);process.exit(1)})" \
        || die "database snapshot failed; nothing changed (use --no-backup to skip)"
      docker run --rm --user 0 --entrypoint sh -v "$src:/d:ro" -v "$bdir:/b" "$old_image" -c \
        "tar czf '/b/$(basename "$backup_file")' -C /d --exclude=./dropit.sqlite --exclude=./dropit.sqlite-wal --exclude=./dropit.sqlite-shm --transform='s,^./.update-backup.sqlite$,./dropit.sqlite,' ." \
        || die "backup failed; nothing changed"
      docker exec "$live" rm -f "$(docker exec "$live" sh -c 'echo ${DATA_DIR:-/data}')/.update-backup.sqlite" || true
    else
      docker run --rm --user 0 --entrypoint tar -v "$src:/d:ro" -v "$bdir:/b" "$old_image" \
        czf "/b/$(basename "$backup_file")" -C /d . || die "backup failed; nothing changed"
    fi
    echo "    $(du -h "$backup_file" | cut -f1)"
  fi

  echo "==> ${compose[*]} build"
  "${compose[@]}" build --build-arg "DROPIT_COMMIT=$DROPIT_COMMIT" --build-arg "DROPIT_BUILD_DATE=$DROPIT_BUILD_DATE" "$service" \
    || die "build failed; the running instance was not touched."
  echo "==> ${compose[*]} up -d"
  "${compose[@]}" up -d --no-build "$service"

  # Post-update check: healthy, reports the new commit, and did not lose its users.
  new=$(docker ps -a -q --filter "label=com.docker.compose.project=$t_project" \
    --filter "label=com.docker.compose.service=$service" | head -n1)
  problem=""
  if [ -z "$new" ]; then
    problem="no container for service $service after up"
  else
    deadline=$(( $(date +%s) + ${DROPIT_UPDATE_TIMEOUT:-120} ))
    ok=0
    while [ "$(date +%s)" -lt "$deadline" ]; do
      if [ "$(docker inspect -f '{{.State.Running}}' "$new")" = true ] && app_get "$new" /healthz >/dev/null; then ok=1; break; fi
      sleep 2
    done
    if [ "$ok" != 1 ]; then
      problem="/healthz did not answer 200 within ${DROPIT_UPDATE_TIMEOUT:-120}s"
    else
      [ "$(container_data "$new")" = "$t_data" ] || problem="new container mounts $(container_data "$new") instead of $t_data"
      version=$(app_get "$new" /api/version || true)
      echo "    /api/version: $version"
      case "$version" in *"\"commit\":\"$after"*|*'"commit":null'*|*'"commit":""'*) ;; *) problem="${problem:+$problem; }running commit is not $after" ;; esac
      users_after=$(count_users "$new")
      echo "    users: $users_before -> $users_after"
      if [ "$users_before" != unknown ] && [ "$users_before" != 0 ] && [ "$users_after" = 0 ]; then
        problem="${problem:+$problem; }user count dropped from $users_before to 0"
      fi
    fi
  fi

  if [ -n "$problem" ]; then
    echo "update.sh: POST-UPDATE CHECK FAILED: $problem" >&2
    if [ -n "$old_image" ] && [ -n "$t_image" ]; then
      echo "==> rolling back to the previous image ($old_image)" >&2
      docker tag "$old_image" "$t_image"
      "${compose[@]}" up -d --no-build --force-recreate "$service" >&2 || true
      echo "    rolled back the container. The code checkout stays at $after (git reset --hard $before to match)." >&2
    else
      echo "    no previous image to roll back to." >&2
    fi
    if [ -n "$backup_file" ]; then
      echo "    data backup: $backup_file" >&2
      echo "    if the data needs restoring too (e.g. after a schema migration):" >&2
      echo "      ${compose[*]} stop $service" >&2
      echo "      docker run --rm --user 0 --entrypoint sh -v '$src:/d' -v '$bdir:/b' $old_image -c 'find /d -mindepth 1 -delete && tar xzf /b/$(basename "$backup_file") -C /d && chown -R 1000:1000 /d'" >&2
      echo "      ${compose[*]} up -d --no-build $service" >&2
    fi
    exit 1
  fi
  echo "Updated to $after (compose: ${compose[*]}, data: $t_data)."
  [ -n "$backup_file" ] && echo "Backup: $backup_file"
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
