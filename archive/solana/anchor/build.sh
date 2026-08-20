#!/usr/bin/env bash
#
# Wrapper for `anchor build` that works around two toolchain incompatibilities
# between Anchor 0.29 / Agave 3.x and a modern rustup. Run this instead of
# `anchor build`.
#
#   1. `cargo-build-sbf` parses `rustup toolchain list -v` by splitting each
#      line on a space, but modern rustup separates the toolchain name from its
#      path with a TAB. The whole line is then treated as the toolchain name,
#      producing:
#        error: invalid value '1.89.0-sbpf-solana-v1.52<TAB>/path/...'
#               for '<toolchain>...': invalid toolchain name
#      Fixed here by a shim that rewrites tabs to spaces for that one command.
#
#   2. Anchor 0.29 invokes `cargo build-bpf`, which Agave 3.x renamed to
#      `cargo build-sbf`. Fixed here by a forwarding shim.
#
# Neither shim changes anything outside this script's PATH.
#
# Usage:  ./build.sh [extra anchor build args]

set -euo pipefail

ANCHOR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOLANA_BIN="$HOME/.local/share/solana/install/active_release/bin"

if [[ ! -x "$SOLANA_BIN/cargo-build-sbf" ]]; then
  echo "error: cargo-build-sbf not found at $SOLANA_BIN" >&2
  echo "       install or update the Solana/Agave CLI first." >&2
  exit 1
fi

SHIM="$(mktemp -d)"
trap 'rm -rf "$SHIM"' EXIT

# (1) rustup shim: normalise tabs to spaces in `toolchain list` output.
cat > "$SHIM/rustup" <<'SHIM_EOF'
#!/usr/bin/env bash
REAL="$RUSTUP_REAL"
if [[ "${1:-}" == "toolchain" && "${2:-}" == "list" ]]; then
  "$REAL" "$@" | sed $'s/\t/ /g'
  exit "${PIPESTATUS[0]}"
fi
exec "$REAL" "$@"
SHIM_EOF

# (2) cargo-build-bpf shim: forward to cargo-build-sbf, dropping argv[1].
cat > "$SHIM/cargo-build-bpf" <<'SHIM_EOF'
#!/usr/bin/env bash
[[ "${1:-}" == "build-bpf" ]] && shift
exec cargo-build-sbf "$@"
SHIM_EOF

chmod +x "$SHIM/rustup" "$SHIM/cargo-build-bpf"

export RUSTUP_REAL="$(command -v rustup)"
export PATH="$SHIM:$SOLANA_BIN:$PATH"

cd "$ANCHOR_DIR"
anchor build "$@"

echo
echo "Built:  target/deploy/holder.so"
echo "IDL:    target/idl/holder.json"
echo
echo "If the IDL changed, copy it to the frontend (keeping metadata.address):"
echo "  python3 -c \"import json; i=json.load(open('target/idl/holder.json')); \\"
echo "    i['metadata']={'address':'\$(solana address -k target/deploy/holder-keypair.json)'}; \\"
echo "    json.dump(i, open('../app/lib/idl.json','w'), indent=2)\""
