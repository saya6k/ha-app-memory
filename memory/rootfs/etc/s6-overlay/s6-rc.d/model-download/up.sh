#!/command/with-contenv bashio
# shellcheck shell=bash
# ==============================================================================
# Fetches the embedding model into /data on first boot.
#
# This is a oneshot, not part of llama-server's run script, because fetching the
# model is a one-time preparation step and not something to retry forever. A
# longrun that exits non-zero is restarted by s6 immediately, which for a
# mis-typed model_sha256 meant re-downloading ~609 MB every few seconds. A
# oneshot that fails is not retried, and with S6_BEHAVIOUR_IF_STAGE2_FAILS=2
# (see Dockerfile) it stops the add-on with the error still on screen.
# ==============================================================================
set -euo pipefail

readonly MODEL_DIR=/data/models

# shellcheck source=/dev/null
source /usr/lib/ha-memory/options.sh

model_repo="$(option model_repo)"
model_file="$(option model_file)"
model_sha="$(option model_sha256)"
model="${MODEL_DIR}/${model_file}"

mkdir -p "${MODEL_DIR}"

if [[ -f "${model}" ]]; then
    bashio::log.info "Embedding model already present: ${model}"
    exit 0
fi

url="https://huggingface.co/${model_repo}/resolve/main/${model_file}"
bashio::log.info "Embedding model not present — downloading ${model_repo}/${model_file}"
bashio::log.info "This is a one-time download of several hundred MB and can take a while."

# -sS keeps the progress meter out of the add-on log while still showing errors.
if ! curl -fsSL --retry 3 --retry-delay 5 -o "${model}.part" "${url}"; then
    bashio::log.fatal "Model download failed: ${url}"
    bashio::log.fatal "Check model_repo and model_file."
    rm -f "${model}.part"
    exit 1
fi

actual="$(sha256sum "${model}.part" | cut -d' ' -f1)"

# model_sha256 is optional: verify when it is set, otherwise print the hash so
# the user can pin it afterwards (SPEC §8 Always).
if [[ -z "${model_sha}" ]]; then
    bashio::log.warning "model_sha256 is not set — the download was NOT verified."
    bashio::log.warning "Set model_sha256 to pin it: ${actual}"
elif [[ "${actual}" != "${model_sha}" ]]; then
    bashio::log.fatal "Model checksum mismatch — refusing to use this file."
    bashio::log.fatal "  expected: ${model_sha}"
    bashio::log.fatal "  actual:   ${actual}"
    bashio::log.fatal "If you changed model_file on purpose, set model_sha256 to the value above."
    rm -f "${model}.part"
    exit 1
else
    bashio::log.info "Checksum verified."
fi

mv "${model}.part" "${model}"
bashio::log.info "Model ready: ${model}"
