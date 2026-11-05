#!/bin/bash
# Builds "SyncWave Online" (the Clip Trimmer and Vocal Remover for the
# website) into "Marketing Website/app/":
#   - the web app (frontend, vite.web.config.js)
#   - the engines it loads at run time: ONNX Runtime Web (AI) and ffmpeg.wasm
#   - the AI models, split into parts (scripts/web-models.mjs)
# The output is generated (not in git); GitHub Actions runs this before
# publishing the website (.github/workflows/pages.yml).
# Preview locally:  bash scripts/build-web.sh && npx serve "Marketing Website"
set -euo pipefail
cd "$(dirname "$0")/.."

APP="Marketing Website/app"
[ -d frontend/node_modules ] || npm ci --prefix frontend
npm --prefix frontend run build:web

rm -rf "$APP"
mkdir -p "$APP/vendor/ort" "$APP/vendor/ffmpeg"
cp -R frontend/dist-web/. "$APP/"
mv "$APP/web.html" "$APP/index.html"

ORT=frontend/node_modules/onnxruntime-web/dist
cp "$ORT/ort.webgpu.min.mjs" "$ORT/ort-wasm-simd-threaded.asyncify.mjs" "$ORT/ort-wasm-simd-threaded.asyncify.wasm" \
   "$ORT/ort.wasm.min.mjs" "$ORT/ort-wasm-simd-threaded.mjs" "$ORT/ort-wasm-simd-threaded.wasm" "$APP/vendor/ort/"
FF=frontend/node_modules/@ffmpeg/core/dist/esm
cp "$FF/ffmpeg-core.js" "$FF/ffmpeg-core.wasm" "$APP/vendor/ffmpeg/"

node scripts/web-models.mjs "$APP/models"
echo "SyncWave Online built in $APP ($(du -sh "$APP" | cut -f1))"
