#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_FILE="$SCRIPT_DIR/can1.service"

echo "Installing can1.service ..."
sudo cp "$SERVICE_FILE" /etc/systemd/system/can1.service
sudo systemctl daemon-reload
sudo systemctl enable can1.service
sudo systemctl start can1.service

echo "Done. can1 status:"
ip link show can1
