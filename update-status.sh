#!/bin/bash
# Companion script: writes status.json from OpenClaw CLI
# Usage: ./update-status.sh (or run in a loop: watch -n5 ./update-status.sh)
cd "$(dirname "$0")"
openclaw sessions --json --active 1440 2>/dev/null > status.json
echo "Updated status.json at $(date)"
