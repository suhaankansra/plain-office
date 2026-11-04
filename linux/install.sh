#!/bin/sh
# Installs Plain Office for the current user without Flatpak, e.g. on
# postmarketOS or Mobian. Needs Python 3, PyGObject, GTK 4, libadwaita and
# WebKitGTK 6.0:
#   postmarketOS / Alpine: sudo apk add py3-gobject3 gtk4.0 libadwaita webkit2gtk-6.0
#   Debian / Mobian:       sudo apt install python3-gi gir1.2-gtk-4.0 gir1.2-adw-1 gir1.2-webkit-6.0
set -e
cd "$(dirname "$0")"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
mkdir -p "$HOME/.local/bin" "$DATA/plain-office" "$DATA/applications" "$DATA/icons/hicolor/scalable/apps"
rm -rf "$DATA/plain-office/web"
cp -r web "$DATA/plain-office/web"
install -m755 plain_office.py "$HOME/.local/bin/plain-office"
install -m644 org.plainoffice.PlainOffice.desktop "$DATA/applications/"
install -m644 icon.svg "$DATA/icons/hicolor/scalable/apps/org.plainoffice.PlainOffice.svg"
update-desktop-database "$DATA/applications" 2>/dev/null || true
echo "Installed. Open Plain Office from your app list, or run: plain-office"
