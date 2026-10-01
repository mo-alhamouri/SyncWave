#!/bin/bash
# Builds SyncWave for Intel (x64) and Apple Silicon (arm64) Macs, each with
# the FFmpeg/FFprobe binaries for its own CPU (npm only installs the host's).
set -euo pipefail

FFMPEG_VER="4.1.0"      # @ffmpeg-installer/darwin-x64
FFMPEG_ARM_VER="4.1.5"  # @ffmpeg-installer/darwin-arm64
FFPROBE_VER="5.1.0"     # @ffprobe-installer/darwin-x64
FFPROBE_ARM_VER="5.0.1" # @ffprobe-installer/darwin-arm64

for ARCH in x64 arm64; do
  if [ "$ARCH" = "x64" ]; then OTHER=arm64; FV=$FFMPEG_VER; PV=$FFPROBE_VER; else OTHER=x64; FV=$FFMPEG_ARM_VER; PV=$FFPROBE_ARM_VER; fi
  echo "=== Building macOS $ARCH ==="
  rm -rf "node_modules/@ffmpeg-installer/darwin-$OTHER" "node_modules/@ffprobe-installer/darwin-$OTHER"
  npm install --no-save --force --ignore-scripts --no-audit --no-fund \
    "@ffmpeg-installer/darwin-$ARCH@$FV" "@ffprobe-installer/darwin-$ARCH@$PV"
  file "node_modules/@ffmpeg-installer/darwin-$ARCH/ffmpeg" "node_modules/@ffprobe-installer/darwin-$ARCH/ffprobe"
  npx electron-builder --mac "--$ARCH" --publish never
done
ls -la dist_electron
