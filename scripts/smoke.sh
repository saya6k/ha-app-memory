#!/bin/sh
# ==============================================================================
# Full-container verification: boots the add-on image under s6 and exercises
# all six MCP tools against the real local embedding sidecar.
#
#   sh scripts/smoke.sh [image-tag]
#
# CI passes the tag it just built. With no argument the image is built here
# first, which is what you want locally. Run it from a Linux host with docker;
# on this Mac that means the `linux-test` container machine (see CLAUDE.md),
# which is aarch64 only:
#
#   container machine run --root -n linux-test -- sh <repo>/scripts/smoke.sh
#
# Env:
#   CACHE_DIR  where the GGUF model and container /data live (default below).
#              Keeping it outside the repo means repeat runs skip the ~609 MiB
#              download.
#   DOCKER_NET  extra `docker` network flags. Needed on the linux-test machine,
#              where dockerd runs with --bridge=none: DOCKER_NET=--network=host
# ==============================================================================
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "${SCRIPT_DIR}")"
ADDON="${REPO}/memory"
CACHE_DIR="${CACHE_DIR:-${HOME}/.cache/ha-app-memory-smoke}"
DOCKER_NET="${DOCKER_NET:---network=host}"
DATA="${CACHE_DIR}/addon-data"
MODEL="Qwen3-Embedding-0.6B-Q8_0.gguf"
IMAGE="${1:-}"

if [ -n "${IMAGE}" ]; then
    echo "########## 1. using prebuilt image ${IMAGE} ##########"
else
    IMAGE=ha-app-memory:test
    echo "########## 1. docker build ##########"
    # shellcheck disable=SC2086
    docker build ${DOCKER_NET} -t "${IMAGE}" "${ADDON}"
fi

echo
echo "########## 2. prepare /data ##########"
mkdir -p "${DATA}/models"
cp "${SCRIPT_DIR}/ci-options.json" "${DATA}/options.json"
# Reuse a previously downloaded model if present; otherwise the add-on's own
# first-boot download path runs (and is itself part of what we verify).
if [ -f "${CACHE_DIR}/${MODEL}" ] && [ ! -f "${DATA}/models/${MODEL}" ]; then
    cp "${CACHE_DIR}/${MODEL}" "${DATA}/models/"
fi
rm -f "${DATA}"/facts.sqlite*
ls -l "${DATA}" "${DATA}/models"

echo
echo "########## 3. run container ##########"
docker rm -f memtest >/dev/null 2>&1 || true
# shellcheck disable=SC2086
docker run -d --name memtest ${DOCKER_NET} \
    -v "${DATA}:/data" \
    -v "${SCRIPT_DIR}:/smoke:ro" \
    "${IMAGE}"

echo "waiting for the MCP endpoint on :8099 (first boot downloads the model) …"
ok=0
i=0
while [ "${i}" -lt 900 ]; do
    # /mcp rejects a bare GET, so any real HTTP status proves it is listening.
    # curl reports 000 when it cannot connect at all — that is NOT ready.
    # `|| true`: a failing curl must not trip `set -e` while polling.
    code="$(docker exec memtest sh -c \
        'curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:8099/mcp' \
        2>/dev/null || true)"
    case "${code}" in
        [1-5][0-9][0-9])
            echo "MCP endpoint answered with HTTP ${code}"
            ok=1; break ;;
    esac
    if [ "$(docker inspect -f '{{.State.Running}}' memtest)" != "true" ]; then
        echo "!! container exited early"; break
    fi
    sleep 2
    i=$((i + 1))
done

echo
echo "########## 4. container logs ##########"
docker logs memtest 2>&1 | tail -40

if [ "${ok}" -ne 1 ]; then
    echo "!! MCP endpoint never came up"
    docker rm -f memtest >/dev/null 2>&1 || true
    exit 1
fi

echo
echo "########## 5. sidecar exposure ##########"
echo "-- llama-server's actual argv (must have no --port, --host must be a .sock) --"
docker exec memtest sh -c \
    'for p in /proc/[0-9]*; do c=$(tr "\0" " " < "$p/cmdline" 2>/dev/null); case "$c" in *llama-server\ --model*) echo "$c"; break;; esac; done' \
    || true
echo "-- socket + directory permissions (directory must be 0700) --"
docker exec memtest ls -la /run/llama/ || true
echo "-- TCP 8080 must NOT answer --"
if docker exec memtest curl -sf --max-time 2 http://127.0.0.1:8080/health >/dev/null 2>&1; then
    echo "!! FAIL: the sidecar is reachable over TCP"
    docker rm -f memtest >/dev/null 2>&1 || true
    exit 1
fi
echo "OK: nothing on TCP 8080"

echo
echo "########## 6. MCP end-to-end ##########"
rc=0
docker exec memtest node /smoke/mcp-smoke.mjs || rc=$?

echo
echo "########## 7. cleanup ##########"
docker rm -f memtest >/dev/null 2>&1 || true
exit "${rc}"
