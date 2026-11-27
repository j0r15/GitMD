#!/bin/bash
# Gitea Renovate Runner
# Run this after pushing changes to main/master

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="$(dirname "$SCRIPT_DIR")"

# Load environment variables
if [[ -f "$WORK_DIR/.env" ]]; then
    export $(grep -v '^#' "$WORK_DIR/.env" | xargs)
fi

echo "=== Gitea Renovate Runner ==="
echo "Server: ${GITEA_SERVER:-$HOME_GITEA_SERVER}"
echo "User: ${GITEA_USER:-$HOME_GITEA_USER}"
echo "Repo: ${GITEA_REPO:-$HOME_GITEA_REPO}"
echo "Branch: main/master"

# Checkout latest changes
cd "$WORK_DIR"
git checkout -f main

# Install Renovate
echo "Installing Renovate..."
npm install -g renovate

# Check if running in a GitHub Actions/Gitea Actions environment
if [[ -n "$GITHUB_TOKEN" ]]; then
    echo "Running with GitHub/Gitea Actions token..."
    renovate --config="$WORK_DIR/renovate.json" schedule
elif [[ -n "$GITEA_TOKEN" ]]; then
    echo "Running with Gitea token..."
    export GITHUB_TOKEN="$GITEA_TOKEN"
    renovate --config="$WORK_DIR/renovate.json" schedule
else
    echo "Running in standalone mode..."
    renovate --config="$WORK_DIR/renovate.json" schedule
fi

echo "=== Renovate Complete ==="
echo "Check the Gitea UI for created PRs"
