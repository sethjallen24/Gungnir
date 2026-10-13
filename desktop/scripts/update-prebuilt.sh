#!/usr/bin/env bash
# Refresh prebuilt/ from a fresh electron-builder build of the Mac app. install-prebuilt-mac.sh
# combines these files with the official Electron download, so Macs can install without Node.
# Run after changing the app, then commit prebuilt/. Works on macOS and Linux.
set -euo pipefail

cd "$(dirname "$0")/.."
APP_NAME="Gungnir"

npx electron-builder --mac --arm64 --dir
APP="release/mac-arm64/$APP_NAME.app/Contents"

mkdir -p prebuilt/plists
cp "$APP/Resources/app.asar" "$APP/Resources/icon.icns" prebuilt/
cp "$APP/Info.plist" prebuilt/plists/Info.plist
cp "$APP/Frameworks/$APP_NAME Helper.app/Contents/Info.plist" prebuilt/plists/Helper.plist
for kind in GPU Plugin Renderer; do
  cp "$APP/Frameworks/$APP_NAME Helper ($kind).app/Contents/Info.plist" "prebuilt/plists/Helper-$kind.plist"
done
node -p "require('electron/package.json').version" > prebuilt/electron-version
echo "Updated prebuilt/ for Electron $(cat prebuilt/electron-version)."
echo "If the Electron version changed, update the checksums in install-prebuilt-mac.sh from"
echo "https://github.com/electron/electron/releases/download/v$(cat prebuilt/electron-version)/SHASUMS256.txt"
