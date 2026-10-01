#!/bin/bash
# SyncWave installer for macOS
#
#   curl -fsSL https://mo-alhamouri.github.io/SyncWave/install.sh | bash
#
# Downloads the latest SyncWave release for this Mac (Intel or Apple Silicon)
# straight from GitHub and installs it into /Applications.
#
# Why use this instead of the .dmg? SyncWave isn't signed with a paid Apple
# Developer ID, so macOS blocks apps downloaded *through a web browser* until
# you approve them in System Settings. Files downloaded with curl aren't
# flagged that way, so SyncWave opens straight away. This only affects
# SyncWave; it does not change any of your Mac's security settings.
set -euo pipefail

REPO="mo-alhamouri/SyncWave"
APP_NAME="SyncWave.app"
DEST_DIR="/Applications"

say() { printf '\033[1;35m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "This installer is for macOS only."

# Apple Silicon reports hw.optional.arm64=1 even inside a Rosetta shell.
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then
  ARCH="arm64"; ARCH_LABEL="Apple Silicon"
else
  ARCH="x64"; ARCH_LABEL="Intel"
fi

say "Looking up the latest SyncWave release..."
# Read the tag from GitHub's releases/latest redirect (no API rate limit).
LATEST_URL=$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/${REPO}/releases/latest") \
  || fail "Could not reach GitHub. Check your internet connection and try again."
TAG="${LATEST_URL##*/tag/}"
case "$TAG" in v[0-9]*) ;; *) fail "Could not find the latest release on GitHub (got: $LATEST_URL)." ;; esac
VERSION="${TAG#v}"
URL="https://github.com/${REPO}/releases/download/${TAG}/SyncWave-${VERSION}-${ARCH}.zip"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

say "Downloading SyncWave ${VERSION} for ${ARCH_LABEL} Macs..."
curl -fL --progress-bar -o "$TMP/SyncWave.zip" "$URL" || fail "Download failed: $URL"

say "Unpacking..."
ditto -x -k "$TMP/SyncWave.zip" "$TMP/unpacked"
[ -d "$TMP/unpacked/$APP_NAME" ] || fail "The download did not contain $APP_NAME."

# Quit a running copy before replacing it.
osascript -e 'tell application "SyncWave" to quit' >/dev/null 2>&1 || true
sleep 1

SUDO=""
if [ ! -w "$DEST_DIR" ] || { [ -e "$DEST_DIR/$APP_NAME" ] && [ ! -w "$DEST_DIR/$APP_NAME" ]; }; then
  say "Administrator password needed to write to $DEST_DIR"
  SUDO="sudo"
fi

say "Installing to $DEST_DIR/$APP_NAME..."
$SUDO rm -rf "$DEST_DIR/$APP_NAME"
$SUDO ditto "$TMP/unpacked/$APP_NAME" "$DEST_DIR/$APP_NAME"
# Remove the download flag from SyncWave only (in case it was set).
$SUDO xattr -dr com.apple.quarantine "$DEST_DIR/$APP_NAME" 2>/dev/null || true

# Clear leftovers from earlier in-app updates (older versions could not remove them).
rm -rf "$HOME/Library/Application Support/syncwave-desktop/updates" 2>/dev/null || true

say "SyncWave ${VERSION} installed. Opening it now..."
open "$DEST_DIR/$APP_NAME"
