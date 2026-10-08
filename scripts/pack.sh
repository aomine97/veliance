#!/bin/bash
# scripts/pack.sh — build dist/Veliance.app from the Electron already in node_modules.
# Uses only macOS built-ins (cp, PlistBuddy, codesign, xattr). No downloads.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="node_modules/electron/dist/Electron.app"
APP="dist/Veliance.app"
PB=/usr/libexec/PlistBuddy
VERSION=$(node -p "require(process.cwd()+'/package.json').version")

[ -d "$SRC" ] || { echo "✗ $SRC not found. Run 'npm start' successfully once first."; exit 1; }

echo "• copying Electron.app → $APP"
rm -rf "$APP"; mkdir -p dist
cp -R "$SRC" "$APP"

echo "• renaming executable + patching Info.plist"
mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/Veliance"
P="$APP/Contents/Info.plist"
set_or_add() { $PB -c "Set :$1 $3" "$P" 2>/dev/null || $PB -c "Add :$1 $2 $3" "$P"; }
set_or_add CFBundleExecutable string Veliance
set_or_add CFBundleName string Veliance
set_or_add CFBundleDisplayName string Veliance
set_or_add CFBundleIdentifier string com.veliance.overlay
set_or_add CFBundleShortVersionString string "$VERSION"
set_or_add CFBundleVersion string "$VERSION"
set_or_add LSUIElement bool true
set_or_add LSApplicationCategoryType string public.app-category.productivity
set_or_add NSMicrophoneUsageDescription string "Veliance uses the microphone for live transcription in Listen mode."
set_or_add NSScreenCaptureUsageDescription string "Veliance captures your screen so you can ask questions about what is on it."
set_or_add NSHighResolutionCapable bool true

echo "• icon + app source"
cp assets/icon.icns "$APP/Contents/Resources/electron.icns"
rm -f "$APP/Contents/Resources/default_app.asar"
mkdir -p "$APP/Contents/Resources/app"
cp -R main.js ai.js store.js preload.js package.json renderer assets "$APP/Contents/Resources/app/"

echo "• signing (ad-hoc) + removing quarantine"
xattr -cr "$APP"
codesign --force --deep --sign - "$APP" 2>&1 | grep -v "replacing existing signature" || true
codesign --verify --deep --strict "$APP" && echo "  signature OK"

echo
echo "✓ $APP  ($(du -sh "$APP" | cut -f1))  — drag it to /Applications"
