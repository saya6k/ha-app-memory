#!/command/with-contenv bashio
# shellcheck shell=bash
# ==============================================================================
# Re-embeds stored facts when the embedding model or vector width has changed.
#
# A oneshot rather than part of mcp-server: migrating is a one-time step, and if
# it fails the add-on must stop once with the reason on screen
# (S6_BEHAVIOUR_IF_STAGE2_FAILS=2) instead of crash-looping the server.
#
# It depends on llama-server, but s6 only orders *starts*, so wait for the
# sidecar's socket to answer before asking it for embeddings.
# ==============================================================================
set -euo pipefail

readonly SOCKET=/run/llama/embed.sock

# shellcheck source=/dev/null
source /usr/lib/ha-memory/options.sh

ready=0
for _ in $(seq 1 900); do
    if curl -sf --max-time 2 --unix-socket "${SOCKET}" \
        http://localhost/health > /dev/null 2>&1; then
        ready=1
        break
    fi
    sleep 2
done

if [[ "${ready}" -ne 1 ]]; then
    bashio::log.fatal "Embedding sidecar did not become ready within 30 minutes."
    exit 1
fi

export DB_PATH=/data/facts.sqlite
export EMBEDDING_BASE_URL=http://localhost
export EMBEDDING_SOCKET_PATH="${SOCKET}"
EMBEDDING_MODEL="$(option model_file)"
EMBEDDING_DIMENSIONS="$(option embedding_dimensions)"
export EMBEDDING_MODEL EMBEDDING_DIMENSIONS

cd /opt/mcp-server
exec node dist/db-migrate.js
