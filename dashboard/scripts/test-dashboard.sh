#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "[1/2] Running unit tests"
npm run test:unit

echo "[2/2] Running terminal E2E smoke test"
npx playwright install chromium >/dev/null 2>&1 || true
npm run test:e2e

echo "All dashboard tests passed."
