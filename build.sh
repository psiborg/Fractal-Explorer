#!/usr/bin/env bash
# Builds the Rust crate to WebAssembly and drops the JS bindings into web/libs/fractal.
# Usage: ./build.sh          (release)
#        ./build.sh --dev    (faster compile, bigger/slower output)
set -euo pipefail
cd "$(dirname "$0")"

profile="--release"
[[ "${1:-}" == "--dev" ]] && profile="--dev"

wasm-pack build $profile --target web --no-pack --out-dir web/libs/fractal
echo "Built. Run ./start.sh to serve it."
