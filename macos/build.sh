#!/bin/sh
# Builds "Plain Office.app" (and optionally a .dmg) into macos/build/.
#   ./build.sh               this Mac's chip only, quick
#   ./build.sh --universal   Apple silicon + Intel
#   ./build.sh --dmg         also make PlainOffice-<version>-mac.dmg
#   --skip-web               reuse the web app already in ../dist
# The app is ad-hoc signed (no Apple Developer account needed); people open it
# the first time with right-click > Open, or System Settings > Privacy & Security.
set -e
cd "$(dirname "$0")"
UNIVERSAL=0; DMG=0; WEB=1
for arg in "$@"; do
  case "$arg" in
    --universal) UNIVERSAL=1 ;;
    --dmg) DMG=1 ;;
    --skip-web) WEB=0 ;;
  esac
done

VERSION=$(node -p "require('../package.json').version")
BUILD=$(grep -m1 versionCode ../android/app/build.gradle | tr -dc '0-9')

if [ "$WEB" = 1 ]; then (cd .. && npm run build); fi
[ -f ../dist/index.html ] || { echo "Build the web app first (npm run build)"; exit 1; }

if [ "$UNIVERSAL" = 1 ]; then
  swift build -c release --arch arm64 --arch x86_64
  BIN=.build/apple/Products/Release/PlainOffice
else
  swift build -c release -j 2
  BIN=.build/release/PlainOffice
fi

APP="build/Plain Office.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
# SwiftPM records the deployment target as the SDK version, which makes macOS
# draw the old (pre-Liquid Glass) look. Record the SDK it was really built with.
SDK=$(xcrun --sdk macosx --show-sdk-version)
xcrun vtool -set-build-version macos 13.0 "$SDK" -replace -output "$APP/Contents/MacOS/PlainOffice" "$BIN"
sed -e "s/__VERSION__/$VERSION/" -e "s/__BUILD__/$BUILD/" Info.plist > "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"
cp AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
cp -R ../dist "$APP/Contents/Resources/web"
codesign --force --deep --sign - "$APP"
echo "Built $APP ($VERSION)"

if [ "$DMG" = 1 ]; then
  STAGE=build/dmg
  rm -rf "$STAGE" && mkdir -p "$STAGE"
  cp -R "$APP" "$STAGE/"
  ln -s /Applications "$STAGE/Applications"
  OUT="build/PlainOffice-$VERSION-mac.dmg"
  rm -f "$OUT"
  hdiutil create -volname "Plain Office" -srcfolder "$STAGE" -ov -format UDZO "$OUT" >/dev/null
  rm -rf "$STAGE"
  echo "Built $OUT"
fi
