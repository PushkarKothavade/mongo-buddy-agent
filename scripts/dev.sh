#!/usr/bin/env bash
# Start the AgentCore app and the React UI together.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -d frontend/node_modules ]]; then
  npm install --prefix frontend
fi

echo "UI talks to the deployed AgentCore runtime. AWS credentials must be available in this shell."
npm run dev --prefix frontend
