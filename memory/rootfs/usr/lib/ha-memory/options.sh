# shellcheck shell=bash
# ==============================================================================
# Reads add-on options. Supervisor is the normal source; without it (plain
# `docker run` verification, SPEC §7) fall back to /data/options.json, which is
# the same file the Supervisor writes.
#
# Defines: option <key>  — prints the value, or nothing if the user has not set
# it. Options declared `?` in config.yaml's schema are absent until opted into,
# and both sources spell "absent" differently, so normalise that here rather
# than in every caller.
# ==============================================================================

if bashio::supervisor.ping 2>/dev/null; then
    _read_option() { bashio::config "${1}" 2>/dev/null || true; }
else
    bashio::log.warning "No Supervisor detected — reading options from /data/options.json"
    _read_option() { jq -r --arg k "${1}" '.[$k] // empty' /data/options.json; }
fi

option() {
    local value
    value="$(_read_option "${1}")"
    # bashio yields the literal string "null" for an option that is not set.
    [[ "${value}" == "null" ]] && value=""
    printf '%s' "${value}"
}
