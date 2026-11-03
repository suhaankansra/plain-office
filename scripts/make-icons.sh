#!/bin/sh
# Regenerates the app icons and launch screens from assets/*.svg.
# macOS only: uses Quick Look (qlmanage) to draw the SVGs and sips to resize.
set -e
cd "$(dirname "$0")/.."
TMP=$(mktemp -d)
qlmanage -t -s 1024 -o "$TMP" assets/icon-square.svg >/dev/null 2>&1
qlmanage -t -s 2732 -o "$TMP" assets/splash.svg >/dev/null 2>&1
ICON="$TMP/icon-square.svg.png"
SPLASH="$TMP/splash.svg.png"

# iOS: the App Store does not allow transparency in the icon.
sips -s format jpeg -s formatOptions 100 "$ICON" --out "$TMP/icon.jpg" >/dev/null
sips -s format png "$TMP/icon.jpg" --out ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png >/dev/null
for f in ios/App/App/Assets.xcassets/Splash.imageset/*.png; do cp "$SPLASH" "$f"; done

# Android 7 and older use these bitmaps; newer versions use the vector
# adaptive icon in res/drawable/ic_launcher_foreground.xml.
for pair in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144 xxxhdpi:192; do
  d=${pair%%:*}
  s=${pair##*:}
  sips -z "$s" "$s" "$ICON" --out "android/app/src/main/res/mipmap-$d/ic_launcher.png" >/dev/null
  sips -z "$s" "$s" "$ICON" --out "android/app/src/main/res/mipmap-$d/ic_launcher_round.png" >/dev/null
done
echo "Icons and launch screens updated."
