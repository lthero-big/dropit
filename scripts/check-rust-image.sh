#!/bin/sh
# Local and CI smoke for the standard build. Uses only a disposable container.
set -eu
image=${1:?usage: check-rust-image.sh IMAGE}
name="dropit-image-check-$$"
cleanup() { docker rm -fv "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
docker run -d --name "$name" --health-interval=1s --health-start-period=1s -p 127.0.0.1::8787 "$image" >/dev/null
port=$(docker port "$name" 8787/tcp | sed 's/.*://')
tries=0
until curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null; do
  tries=$((tries+1)); test "$tries" -lt 60 || { docker logs "$name"; exit 1; }
  sleep 1
done
docker exec "$name" sh -ec 'test "$(id -u)" = 1000; test "$(id -g)" = 1000; test -x /usr/local/bin/dropit-server; ! command -v node; dropit-admin help; dropit-admin list-users; test "$(stat -c %a /data)" = 700'
curl -fsS "http://127.0.0.1:$port/" | grep -q '<div id="root">'
# The client-facing JSON is the build contract; Node is only a host-side verifier.
image_revision=$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
image_version=$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.version"}}')
image_date=$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.created"}}')
test -z "${DROPIT_COMMIT:-}" || test "$image_revision" = "$DROPIT_COMMIT"
test -z "${DROPIT_VERSION:-}" || test "$image_version" = "$DROPIT_VERSION"
test -z "${DROPIT_BUILD_DATE:-}" || test "$image_date" = "$DROPIT_BUILD_DATE"
curl -fsS "http://127.0.0.1:$port/api/version" | node -e 'let s="";process.stdin.on("data",b=>s+=b).on("end",()=>{const b=JSON.parse(s);console.log(b);if(b.commit!==process.argv[1].slice(0,7)||b.version!==process.argv[2]||b.buildDate!==new Date(process.argv[3]).toISOString()||b.install!=="docker")process.exit(1)})' "$image_revision" "$image_version" "$image_date"
tries=0
until test "$(docker inspect "$name" --format '{{.State.Health.Status}}')" = healthy; do
  tries=$((tries+1)); test "$tries" -lt 30 || exit 1
  sleep 1
done
docker stop -t 15 "$name" >/dev/null
test "$(docker inspect "$name" --format '{{.State.ExitCode}}')" = 0
printf 'PASS Rust image: metadata, static Web, admin, UID/GID, no Node, health, SIGTERM\n'
