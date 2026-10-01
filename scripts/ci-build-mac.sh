#!/bin/bash
# Builds SyncWave for Intel (x64) and Apple Silicon (arm64) Macs, each with
# the FFmpeg/FFprobe binaries for its own CPU. npm only installs the build
# machine's binaries, so the right ones are fetched with `npm pack` (which
# never prunes or rewrites node_modules) and dropped in place per build.
set -euo pipefail

ver() { # works with macOS's bash 3.2 (no associative arrays)
  case "$1" in
    ffmpeg-x64) echo 4.1.0 ;;  ffmpeg-arm64) echo 4.1.5 ;;
    ffprobe-x64) echo 5.1.0 ;; ffprobe-arm64) echo 5.0.1 ;;
  esac
}
WORK=$(mktemp -d)

fetch() { # tool arch
  local tool=$1 arch=$2 pkg="@${1}-installer/darwin-${2}"
  local dest="node_modules/@${tool}-installer/darwin-${arch}"
  (cd "$WORK" && npm pack --silent "${pkg}@$(ver "$tool-$arch")" >/dev/null)
  rm -rf "$dest" && mkdir -p "$dest"
  tar -xzf "$WORK"/${tool}-installer-darwin-${arch}-*.tgz -C "$dest" --strip-components=1
  chmod +x "$dest/$tool"
}

for ARCH in x64 arm64; do
  OTHER=$([ "$ARCH" = x64 ] && echo arm64 || echo x64)
  MACHO=$([ "$ARCH" = x64 ] && echo x86_64 || echo arm64)
  echo "=== Building macOS $ARCH ==="
  rm -rf node_modules/@ffmpeg-installer/darwin-* node_modules/@ffprobe-installer/darwin-*
  fetch ffmpeg "$ARCH"
  fetch ffprobe "$ARCH"
  for b in "node_modules/@ffmpeg-installer/darwin-$ARCH/ffmpeg" "node_modules/@ffprobe-installer/darwin-$ARCH/ffprobe"; do
    file "$b"
    file "$b" | grep -q "$MACHO" || { echo "Wrong architecture for $b"; exit 1; }
  done
  npx electron-builder --mac "--$ARCH" --publish never

  # Verify the packaged app really contains only this CPU's processors.
  APPDIR=$([ "$ARCH" = x64 ] && echo dist_electron/mac || echo dist_electron/mac-arm64)
  found=$(find "$APPDIR/SyncWave.app/Contents/Resources/app.asar.unpacked" -type f \( -name ffmpeg -o -name ffprobe \))
  echo "$found"
  echo "$found" | grep -q "darwin-$OTHER" && { echo "Found $OTHER binaries in $ARCH build"; exit 1; }
  echo "$found" | grep -q "darwin-$ARCH/ffmpeg" || { echo "ffmpeg missing from $ARCH build"; exit 1; }
done

# Final check on what actually gets published: unpack each zip and make sure
# the app and its FFmpeg/FFprobe match that zip's CPU.
for ARCH in x64 arm64; do
  MACHO=$([ "$ARCH" = x64 ] && echo x86_64 || echo arm64)
  ZIP=$(ls dist_electron/SyncWave-*-"$ARCH".zip)
  CHK="$WORK/check-$ARCH"; rm -rf "$CHK"; mkdir -p "$CHK"
  ditto -x -k "$ZIP" "$CHK"
  for b in "$CHK/SyncWave.app/Contents/MacOS/SyncWave" $(find "$CHK/SyncWave.app" -type f \( -name ffmpeg -o -name ffprobe \)); do
    file "$b"
    file "$b" | grep -q "$MACHO" || { echo "ERROR: $ZIP contains a non-$ARCH binary: $b"; exit 1; }
  done
  codesign --verify --deep --strict "$CHK/SyncWave.app" && echo "$ZIP signature OK"
done
ls -la dist_electron
