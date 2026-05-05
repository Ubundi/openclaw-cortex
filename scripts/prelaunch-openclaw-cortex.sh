#!/usr/bin/env bash

set -euo pipefail

PLUGIN_PACKAGE="@ubundi/openclaw-cortex"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_PLUGIN_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/prelaunch-openclaw-cortex.sh [workspace-dir] [--plugin-dir /path/to/openclaw-cortex] [--launch]

Examples:
  ./scripts/prelaunch-openclaw-cortex.sh
  ./scripts/prelaunch-openclaw-cortex.sh /path/to/workspace
  ./scripts/prelaunch-openclaw-cortex.sh /path/to/workspace --plugin-dir /path/to/openclaw-cortex --launch

What it does:
  1. Installs the Cortex plugin into OpenClaw.
  2. Creates or updates openclaw.json in the target workspace.
  3. Enables the plugin and assigns it to plugins.slots.memory.
  4. Optionally launches OpenClaw from that workspace.

Defaults:
  workspace-dir  Current directory
  --plugin-dir   Uses the current repo if it looks like an openclaw-cortex checkout.
                 Otherwise installs the published npm package.
EOF
}

log() {
  printf '[openclaw-cortex] %s\n' "$1"
}

fail() {
  printf '[openclaw-cortex] ERROR: %s\n' "$1" >&2
  exit 1
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Missing required command: $1"
  fi
}

workspace_dir="$(pwd)"
plugin_dir=""
launch_after_setup=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --plugin-dir)
      [[ $# -ge 2 ]] || fail "--plugin-dir requires a path"
      plugin_dir="$2"
      shift 2
      ;;
    --launch)
      launch_after_setup=true
      shift
      ;;
    -*)
      fail "Unknown option: $1"
      ;;
    *)
      workspace_dir="$1"
      shift
      ;;
  esac
done

need_cmd node
need_cmd npm
need_cmd openclaw

workspace_dir="$(cd "$workspace_dir" && pwd)"

if [[ -z "$plugin_dir" ]]; then
  if [[ -f "${DEFAULT_PLUGIN_DIR}/openclaw.plugin.json" && -f "${DEFAULT_PLUGIN_DIR}/package.json" ]]; then
    plugin_dir="$DEFAULT_PLUGIN_DIR"
  fi
fi

install_mode="registry"
if [[ -n "$plugin_dir" ]]; then
  plugin_dir="$(cd "$plugin_dir" && pwd)"
  [[ -f "${plugin_dir}/package.json" ]] || fail "No package.json found in plugin directory: ${plugin_dir}"
  [[ -f "${plugin_dir}/openclaw.plugin.json" ]] || fail "No openclaw.plugin.json found in plugin directory: ${plugin_dir}"
  install_mode="local"
fi

mkdir -p "$workspace_dir"

if [[ "$install_mode" == "local" ]]; then
  log "Preparing local plugin build from ${plugin_dir}"
  if [[ ! -d "${plugin_dir}/node_modules" ]]; then
    if [[ -f "${plugin_dir}/package-lock.json" ]]; then
      (cd "$plugin_dir" && npm ci)
    else
      (cd "$plugin_dir" && npm install)
    fi
  fi
  (cd "$plugin_dir" && npm run build)
  log "Installing plugin into OpenClaw from local checkout"
  openclaw plugins install -l "$plugin_dir"
else
  log "Installing published plugin package ${PLUGIN_PACKAGE}"
  openclaw plugins install "$PLUGIN_PACKAGE"
fi

config_path="${workspace_dir}/openclaw.json"
if [[ ! -f "$config_path" ]]; then
  log "Creating ${config_path}"
  printf '{}\n' > "$config_path"
fi

backup_path="${config_path}.bak.$(date +%Y%m%d%H%M%S)"
cp "$config_path" "$backup_path"
log "Backed up existing config to ${backup_path}"

node "${SCRIPT_DIR}/ensure-openclaw-cortex-config.mjs" "$config_path"

log "OpenClaw workspace is ready at ${workspace_dir}"
log "Cortex plugin is enabled in ${config_path}"

if [[ "$launch_after_setup" == true ]]; then
  log "Launching OpenClaw from ${workspace_dir}"
  cd "$workspace_dir"
  exec openclaw
fi

printf '\n'
log "Next step: cd ${workspace_dir} && openclaw"
