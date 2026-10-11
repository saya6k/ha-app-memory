# shellcheck shell=bash
# ==============================================================================
# Embedding settings shared by db-migrate and mcp-server. Source options.sh
# first.
#
# Defines:
#   embedding_provider  — prints local, openai, huggingface or ollama
#   export_embedding_env — exports what the Node side reads (see config.ts)
#   wait_for_sidecar    — waits for the local llama.cpp sidecar; returns at
#                         once for a remote provider, 1 if it never came up
# ==============================================================================

readonly SIDECAR_SOCKET=/run/llama/embed.sock

embedding_provider() {
    local provider
    provider="$(option embedding_provider)"
    printf '%s' "${provider:-local}"
}

export_embedding_env() {
    EMBEDDING_PROVIDER="$(embedding_provider)"
    export EMBEDDING_PROVIDER

    if [[ "${EMBEDDING_PROVIDER}" == "local" ]]; then
        export EMBEDDING_BASE_URL=http://localhost/v1
        export EMBEDDING_SOCKET_PATH="${SIDECAR_SOCKET}"
        EMBEDDING_MODEL="$(option model_file)"
    else
        # Empty values are left to the app: it fills in well-known URLs and
        # names whatever required setting is missing.
        EMBEDDING_BASE_URL="$(option embedding_url)"
        EMBEDDING_MODEL="$(option embedding_model)"
        export EMBEDDING_BASE_URL
        local api_key
        api_key="$(option embedding_api_key)"
        if [[ -n "${api_key}" ]]; then
            export EMBEDDING_API_KEY="${api_key}"
        fi
    fi

    EMBEDDING_DIMENSIONS="$(option embedding_dimensions)"
    # Unset prefixes come through as "", which is what the app defaults to anyway.
    EMBEDDING_QUERY_PREFIX="$(option query_prefix)"
    EMBEDDING_DOCUMENT_PREFIX="$(option document_prefix)"
    export EMBEDDING_MODEL EMBEDDING_DIMENSIONS EMBEDDING_QUERY_PREFIX EMBEDDING_DOCUMENT_PREFIX

    local chunk_size
    chunk_size="$(option chunk_size)"
    if [[ -n "${chunk_size}" ]]; then
        export CHUNK_SIZE="${chunk_size}"
    fi
}

# s6 dependencies order *starts*, not readiness. On first boot the sidecar is
# still downloading the model before it binds, so poll generously (30 min).
wait_for_sidecar() {
    [[ "$(embedding_provider)" == "local" ]] || return 0

    for _ in $(seq 1 900); do
        if curl -sf --max-time 2 --unix-socket "${SIDECAR_SOCKET}" \
            http://localhost/health > /dev/null 2>&1; then
            return 0
        fi
        sleep 2
    done
    return 1
}
