#!/usr/bin/env bash
# Serves web/ at http://localhost:8080 (or the port given) and opens the browser.
# Usage: ./start.sh [port]
set -euo pipefail
cd "$(dirname "$0")"

port="${1:-8080}"
url="http://localhost:${port}"

if command -v python3 >/dev/null 2>&1; then
  py=python3
elif command -v python >/dev/null 2>&1; then
  py=python
else
  echo "Python 3 is not installed." >&2
  exit 1
fi

# Open the browser shortly after the server starts (macOS: open, Linux: xdg-open).
if command -v open >/dev/null 2>&1; then
  (sleep 1 && open "$url") &
elif command -v xdg-open >/dev/null 2>&1; then
  (sleep 1 && xdg-open "$url" >/dev/null 2>&1) &
fi

exec "$py" serve.py "$port"
