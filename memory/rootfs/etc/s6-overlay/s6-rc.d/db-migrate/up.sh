#!/command/with-contenv bashio
# shellcheck shell=bash
# ==============================================================================
# Re-embeds stored facts when the embedding model or vector width has changed,
# and empties the document index when it was built differently.
#
# A oneshot rather than part of mcp-server: migrating is a one-time step, and if
# it fails the add-on must stop once with the reason on screen
# (S6_BEHAVIOUR_IF_STAGE2_FAILS=2) instead of crash-looping the server.
#
# It depends on llama-server, but s6 only orders *starts*, so wait for the
# sidecar's socket to answer before asking it for embeddings (a remote
# provider has nothing to wait for).
# ==============================================================================
set -euo pipefail

# shellcheck source=/dev/null
source /usr/lib/ha-memory/options.sh
# shellcheck source=/dev/null
source /usr/lib/ha-memory/embedding.sh

if ! wait_for_sidecar; then
    bashio::log.fatal "Embedding sidecar did not become ready within 30 minutes."
    exit 1
fi

export DB_PATH=/data/facts.sqlite
export_embedding_env

cd /opt/mcp-server
exec node dist/db-migrate.js
