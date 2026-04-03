#!/usr/bin/env bash
# Sovereign — Hook Compilation Pipeline
# Compiles C hooks to WebAssembly (.wasm) for Xahau deployment.
#
# Approach: Uses the Xahau hooks-toolkit Docker image which bundles
# clang with wasm32 target + wasm-ld + hook-specific headers.
#
# If Docker is unavailable, falls back to a local clang with wasm target.
#
# Usage:
#   ./scripts/build-hooks.sh          # Build all hooks
#   ./scripts/build-hooks.sh clean    # Remove build artifacts
#   ./scripts/build-hooks.sh <hook>   # Build a single hook (e.g. seat_registry)

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOKS_DIR="${PROJECT_ROOT}/hooks"
BUILD_DIR="${PROJECT_ROOT}/build/hooks"
INCLUDE_DIR="${HOOKS_DIR}"

# All hooks to compile
ALL_HOOKS=(
  seat_registry
  vote_enforcer
  stake_lockbox
  governance_lock
  branch_activation
  rotation_enforcer
)

# Clang flags for Xahau hook compilation (wasm32 target)
CLANG_FLAGS=(
  --target=wasm32
  -Os
  -nostdlib
  -fno-builtin
  -std=c11
  -Wall
  -Wextra
  -Wno-unused-parameter
  -I"${INCLUDE_DIR}"
)

WASM_LD_FLAGS=(
  --no-entry
  --allow-undefined
  --export=hook
  --export=cbak
  -z stack-size=8192
  --initial-memory=65536
  --max-memory=65536
)

# --- Functions ---

log() {
  echo "[hooks] $*"
}

err() {
  echo "[hooks] ERROR: $*" >&2
}

clean() {
  log "Cleaning build artifacts..."
  rm -rf "${BUILD_DIR}"
  log "Done."
}

ensure_build_dir() {
  mkdir -p "${BUILD_DIR}"
}

# Try Docker-based compilation using hooks-toolkit image
build_with_docker() {
  local hook_name="$1"
  local src="${HOOKS_DIR}/${hook_name}.c"
  local obj="${BUILD_DIR}/${hook_name}.o"
  local wasm="${BUILD_DIR}/${hook_name}.wasm"

  if [[ ! -f "$src" ]]; then
    err "Source file not found: $src"
    return 1
  fi

  log "Compiling ${hook_name}.c → ${hook_name}.wasm (Docker)"

  # Use the hooks-toolkit Docker image
  # This image contains clang with wasm32 target and the official hookapi.h
  docker run --rm \
    -v "${HOOKS_DIR}:/hooks:ro" \
    -v "${BUILD_DIR}:/build" \
    -w /hooks \
    --entrypoint /bin/sh \
    ghcr.io/xahau/hooks-toolkit:latest \
    -c "
      clang ${CLANG_FLAGS[*]} -c /hooks/${hook_name}.c -o /build/${hook_name}.o && \
      wasm-ld ${WASM_LD_FLAGS[*]} /build/${hook_name}.o -o /build/${hook_name}.wasm
    " 2>&1

  if [[ -f "$wasm" ]]; then
    local size
    size=$(wc -c < "$wasm")
    log "✓ ${hook_name}.wasm (${size} bytes)"
    return 0
  else
    err "Failed to produce ${hook_name}.wasm"
    return 1
  fi
}

# Fallback: local clang compilation
build_with_local_clang() {
  local hook_name="$1"
  local src="${HOOKS_DIR}/${hook_name}.c"
  local obj="${BUILD_DIR}/${hook_name}.o"
  local wasm="${BUILD_DIR}/${hook_name}.wasm"

  if [[ ! -f "$src" ]]; then
    err "Source file not found: $src"
    return 1
  fi

  log "Compiling ${hook_name}.c → ${hook_name}.wasm (local clang)"

  clang "${CLANG_FLAGS[@]}" -c "$src" -o "$obj"
  wasm-ld "${WASM_LD_FLAGS[@]}" "$obj" -o "$wasm"

  if [[ -f "$wasm" ]]; then
    local size
    size=$(wc -c < "$wasm")
    log "✓ ${hook_name}.wasm (${size} bytes)"
    return 0
  else
    err "Failed to produce ${hook_name}.wasm"
    return 1
  fi
}

# Build a single hook — try Docker first, fall back to local clang
build_hook() {
  local hook_name="$1"
  ensure_build_dir

  if command -v docker &>/dev/null; then
    build_with_docker "$hook_name" && return 0
    log "Docker build failed, trying local clang..."
  fi

  if command -v clang &>/dev/null && command -v wasm-ld &>/dev/null; then
    build_with_local_clang "$hook_name" && return 0
  fi

  err "No build toolchain available."
  err "Install one of:"
  err "  1. Docker (recommended) — uses ghcr.io/xahau/hooks-toolkit"
  err "  2. clang + wasm-ld with wasm32 target (apt install clang lld)"
  return 1
}

build_all() {
  log "Building all ${#ALL_HOOKS[@]} hooks..."
  local failed=0

  for hook in "${ALL_HOOKS[@]}"; do
    if ! build_hook "$hook"; then
      failed=$((failed + 1))
    fi
  done

  echo ""
  if [[ $failed -eq 0 ]]; then
    log "✓ All hooks compiled successfully."
    log "Output: ${BUILD_DIR}/"
    ls -la "${BUILD_DIR}"/*.wasm 2>/dev/null
  else
    err "${failed} hook(s) failed to compile."
    return 1
  fi
}

# --- Main ---

case "${1:-all}" in
  clean)
    clean
    ;;
  all)
    build_all
    ;;
  *)
    # Single hook name passed
    build_hook "$1"
    ;;
esac
