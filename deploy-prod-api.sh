#!/usr/bin/env bash
set -euo pipefail

REMOTE_USER="ccdev"
REMOTE_HOST="10.4.23.197"
STAGE_DIR="/home/${REMOTE_USER}/pp-api-stage"

# Exclusions: no Git, no .env*, no node_modules
rsync -avz \
  --exclude=".git/" \
  --exclude=".gitignore" \
  --exclude=".gitattributes" \
  --exclude=".env" \
  --exclude=".env.*" \
  --exclude="node_modules/" \
  ./ "${REMOTE_USER}@${REMOTE_HOST}:${STAGE_DIR}/"

echo "Staged to ${REMOTE_USER}@${REMOTE_HOST}:${STAGE_DIR}"

