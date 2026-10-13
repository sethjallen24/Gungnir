#!/usr/bin/env bash
# Install the Gungnir Mac app without building it (no Node.js needed).
# Downloads the official Electron runtime, checks its checksum, adds the prebuilt app files from
# prebuilt/ (the same files electron-builder would produce), signs the app ad hoc for this
# Mac and installs it into Applications.
# Usage: bash desktop/install-prebuilt-mac.sh
set -euo pipefail

cd "$(dirname "$0")"
APP_NAME="Gungnir"
ELECTRON_VERSION="$(cat prebuilt/electron-version)"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This installer is for macOS."
  exit 1
fi

# Checksums from https://github.com/electron/electron/releases/download/v44.7.0/SHASUMS256.txt
case "$(uname -m)" in
  arm64) ARCH=arm64; SHA256=e04e411b58a0a14375dd21b0ab4a378fd38930a702e4e20e322fee4849404c0b ;;
  x86_64) ARCH=x64; SHA256=4fe494a7159b10a81e2098dab388719582065e99e604c4510bb117e282213566 ;;
  *) echo "Unsupported Mac architecture: $(uname -m)"; exit 1 ;;
esac
if [[ "$ELECTRON_VERSION" != "44.7.0" ]]; then
  echo "prebuilt/ is for Electron $ELECTRON_VERSION but this script has checksums for 44.7.0; update the script."
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ZIP="electron-v$ELECTRON_VERSION-darwin-$ARCH.zip"
echo "Downloading Electron $ELECTRON_VERSION for $ARCH (about 110 MB)..."
curl -fL --progress-bar -o "$WORK/$ZIP" "https://github.com/electron/electron/releases/download/v$ELECTRON_VERSION/$ZIP"
echo "$SHA256  $WORK/$ZIP" | shasum -a 256 -c - >/dev/null || { echo "Checksum mismatch: the download is corrupt or not the official build."; exit 1; }

echo "Assembling $APP_NAME.app..."
ditto -x -k "$WORK/$ZIP" "$WORK/unzipped"
APP="$WORK/$APP_NAME.app"
mv "$WORK/unzipped/Electron.app" "$APP"
mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/$APP_NAME"
for kind in "" GPU Plugin Renderer; do
  suffix="${kind:+ ($kind)}"
  helper="$APP/Contents/Frameworks/$APP_NAME Helper$suffix.app"
  mv "$APP/Contents/Frameworks/Electron Helper$suffix.app" "$helper"
  mv "$helper/Contents/MacOS/Electron Helper$suffix" "$helper/Contents/MacOS/$APP_NAME Helper$suffix"
  cp "prebuilt/plists/Helper${kind:+-$kind}.plist" "$helper/Contents/Info.plist"
done
cp prebuilt/plists/Info.plist "$APP/Contents/Info.plist"
rm "$APP/Contents/Resources/default_app.asar" "$APP/Contents/Resources/electron.icns"
cp prebuilt/app.asar prebuilt/icon.icns "$APP/Contents/Resources/"

# No Apple Developer ID signature, so sign ad hoc for this Mac (Apple Silicon requires a valid one).
xattr -cr "$APP"
codesign --force --deep --sign - "$APP"

DEST="${GUNGNIR_INSTALL_DIR:-/Applications}"
if [[ ! -w "$DEST" ]]; then
  DEST="$HOME/Applications"
  mkdir -p "$DEST"
fi
# Quit a running copy before replacing it (its data lives in Application Support and is kept).
osascript -e "tell application \"$APP_NAME\" to quit" >/dev/null 2>&1 || true
rm -rf "${DEST:?}/$APP_NAME.app"
ditto "$APP" "$DEST/$APP_NAME.app"

echo
echo "Installed $DEST/$APP_NAME.app"
echo "The server address and sign-in are kept in ~/Library/Application Support/$APP_NAME"
open "$DEST/$APP_NAME.app"
