#!/usr/bin/env bash
#
# Setup git sparse-checkout for edge-only or host-only deployment.
#
# On Jetson (edge):
#   bash scripts/setup_sparse_checkout.sh edge
#
# On RTX server (host):
#   bash scripts/setup_sparse_checkout.sh host
#
# To go back to full repo:
#   git sparse-checkout disable
#
set -euo pipefail

ROLE="${1:-}"

if [[ "$ROLE" != "edge" && "$ROLE" != "host" ]]; then
    echo "Usage: $0 <edge|host>"
    echo ""
    echo "  edge  - Jetson Orin NX: clones edge/ + shared/ only"
    echo "  host  - RTX server:     clones host/ + shared/ only"
    exit 1
fi

git sparse-checkout init --cone

if [[ "$ROLE" == "edge" ]]; then
    git sparse-checkout set edge/ shared/ scripts/ .gitignore .gitmodules README.md
    echo "Sparse checkout configured for EDGE (Jetson)."
    echo "  Visible: edge/, shared/, scripts/"
    echo "  Next: cd edge && colcon build"
elif [[ "$ROLE" == "host" ]]; then
    git sparse-checkout set host/ shared/ scripts/ .gitignore README.md
    echo "Sparse checkout configured for HOST (server)."
    echo "  Visible: host/, shared/, scripts/"
    echo "  Next: cd host && uv sync"
    echo "        cd host/web && npm install && npm run build"
fi
