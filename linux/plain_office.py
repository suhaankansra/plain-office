#!/usr/bin/env python3
"""Plain Office for Linux phones and computers.

A GTK 4 / libadwaita window that shows the Plain Office web app with the
system's WebKitGTK. Works on GNOME (Phosh, GNOME Mobile), Plasma Mobile and
any desktop. The app files are served to the window from this machine only
(127.0.0.1, behind a random secret path), nothing is downloaded, and the
Flatpak build has no network access at all.
"""

import base64
import functools
import http.server
import mimetypes
import os
import secrets
import socketserver
import sys
import threading
from pathlib import Path

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
gi.require_version("WebKit", "6.0")
from gi.repository import Adw, Gio, GLib, Gtk, WebKit  # noqa: E402

APP_ID = "org.plainoffice.PlainOffice"
# CI checks: "1" creates a document, "2" (a second launch) checks it is still there.
SMOKE_TEST = os.environ.get("PLAIN_OFFICE_SMOKE_TEST", "")


def find_web_root():
    candidates = [
        os.environ.get("PLAIN_OFFICE_WEB"),
        Path(__file__).resolve().parent / "web",
        Path("/app/share/plain-office/web"),
        Path("/usr/share/plain-office/web"),
        Path.home() / ".local/share/plain-office/web",
    ]
    for c in candidates:
        if c and (Path(c) / "index.html").is_file():
            return Path(c)
    sys.exit("Plain Office: could not find the app files (web/index.html).")


# ---------- Local file server ----------
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("application/wasm", ".wasm")


class AppFiles(http.server.SimpleHTTPRequestHandler):
    """Serves the app's own files, and only to requests carrying the secret path."""

    token = ""

    def translate_path(self, path):
        prefix = f"/{self.token}/"
        if not path.startswith(prefix):
            return "/nonexistent"
        return super().translate_path("/" + path[len(prefix):])

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True  # lets a relaunch take the same port right away


# The web engine keeps saved documents per address (including the port), so
# the app always tries the same port. Inside Flatpak the app has its own
# private network, so nothing else can be using it.
PORTS = range(47312, 47322)


def start_server(root):
    AppFiles.token = secrets.token_urlsafe(16)
    handler = functools.partial(AppFiles, directory=str(root))
    for port in PORTS:
        try:
            server = Server(("127.0.0.1", port), handler)
            break
        except OSError:
            continue
    else:
        sys.exit("Plain Office: no free local port to start on.")
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{server.server_address[1]}/{AppFiles.token}/"


# ---------- Window ----------
class Window(Adw.ApplicationWindow):
    def __init__(self, app, base_url):
        super().__init__(application=app, title="Plain Office", default_width=420, default_height=860)
        self.base_url = base_url
        self.loaded = False
        self.pending = []

        data = Path(GLib.get_user_data_dir()) / "plain-office"
        cache = Path(GLib.get_user_cache_dir()) / "plain-office"
        session = WebKit.NetworkSession.new(str(data), str(cache))
        session.connect("download-started", self.on_download)

        self.view = WebKit.WebView(network_session=session)
        settings = self.view.get_settings()
        settings.set_enable_developer_extras(bool(os.environ.get("PLAIN_OFFICE_DEBUG")))
        settings.set_enable_write_console_messages_to_stdout(bool(os.environ.get("PLAIN_OFFICE_DEBUG") or SMOKE_TEST))
        self.view.connect("decide-policy", self.on_policy)
        self.view.connect("load-changed", self.on_load)
        self.set_content(self.view)

        # Escape works like the phone's back gesture: close a menu, then the editor.
        keys = Gtk.ShortcutController()
        keys.add_shortcut(Gtk.Shortcut(
            trigger=Gtk.ShortcutTrigger.parse_string("Escape"),
            action=Gtk.CallbackAction.new(lambda *_: self.run_js("window.plainOffice?.back()") or True),
        ))
        self.add_controller(keys)

        self.view.load_uri(base_url + "index.html")

    # Stay inside the app: no browsing to other sites.
    def on_policy(self, view, decision, kind):
        if kind in (WebKit.PolicyDecisionType.NAVIGATION_ACTION, WebKit.PolicyDecisionType.NEW_WINDOW_ACTION):
            uri = decision.get_navigation_action().get_request().get_uri()
            if not (uri.startswith(self.base_url) or uri.startswith("blob:") or uri.startswith("data:") or uri == "about:blank"):
                decision.ignore()
                return True
        return False

    def on_load(self, view, event):
        if event != WebKit.LoadEvent.FINISHED:
            return
        self.loaded = True
        for path in self.pending:
            self.open_path(path)
        self.pending = []
        if SMOKE_TEST:
            GLib.timeout_add_seconds(4, self.smoke_test)

    def run_js(self, script, callback=None):
        def done(view, result, *_):
            try:
                value = view.evaluate_javascript_finish(result)
                if callback:
                    callback(value.to_string() if value else "")
            except GLib.Error as err:
                if callback:
                    callback(f"ERROR {err.message}")
        self.view.evaluate_javascript(script, -1, None, None, None, done, None)

    # Files opened with "Open with Plain Office" or passed on the command line.
    def open_path(self, path):
        if not self.loaded:
            self.pending.append(path)
            return
        try:
            data = Path(path).read_bytes()
        except OSError as err:
            print(f"Plain Office: cannot read {path}: {err}", file=sys.stderr)
            return
        b64 = base64.b64encode(data).decode()
        name = Path(path).name.replace("\\", "\\\\").replace("'", "\\'")
        self.run_js(f"window.plainOffice?.open('{b64}', '{name}')")

    # "Save a copy" in the app downloads the file: put it in Downloads.
    def on_download(self, session, download):
        state = {"name": None, "failed": False}

        def destination(dl, suggested):
            folder = Path(GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) or Path.home() / "Downloads")
            folder.mkdir(parents=True, exist_ok=True)
            target = folder / Path(suggested or "document").name
            stem, suffix, n = target.stem, target.suffix, 1
            while target.exists():
                n += 1
                target = folder / f"{stem} ({n}){suffix}"
            dl.set_destination(str(target))
            state["name"] = target.name
            return True

        def finished(dl):
            if state["name"] and not state["failed"]:
                name = state["name"].replace("\\", "\\\\").replace("'", "\\'")
                self.run_js(f"window.plainOffice?.saved('{name}')")

        def failed(dl, error):
            state["failed"] = True

        download.connect("decide-destination", destination)
        download.connect("failed", failed)
        download.connect("finished", finished)

    # Used by CI: check the home screen loads and a document can be created and saved.
    def smoke_test(self):
        script = """
        (async () => {
          const title = document.querySelector('.home h1')?.textContent;
          const files = document.querySelectorAll('.file-row').length;
          const tiles = document.querySelectorAll('.new-tile').length;
          [...document.querySelectorAll('.new-tile')].find((b) => b.textContent.includes('Document'))?.click();
          await new Promise((r) => setTimeout(r, 2500));
          const editor = !!document.querySelector('.doc-page');
          return JSON.stringify({ title, tiles, editor, files });
        })()
        """

        def report(result):
            print(f"SMOKE {result}", flush=True)
            ok = '"title":"Plain Office"' in result and '"editor":true' in result
            if SMOKE_TEST == "2":
                ok = ok and '"files":0' not in result
            self.get_application().exit_code = 0 if ok else 1
            self.get_application().quit()

        # evaluate_javascript does not await promises, so poll a global.
        self.run_js(f"window.__smoke = null; ({script}).then((v) => window.__smoke = v)")
        attempts = {"n": 0}

        def poll():
            attempts["n"] += 1

            def check(value):
                if value and value not in ("null", "undefined"):
                    report(value)
                elif attempts["n"] > 30:
                    report("timeout")
                else:
                    GLib.timeout_add(500, poll)
            self.run_js("window.__smoke", check)
            return False

        GLib.timeout_add(500, poll)
        return False


class App(Adw.Application):
    def __init__(self):
        super().__init__(application_id=APP_ID, flags=Gio.ApplicationFlags.HANDLES_OPEN)
        self.base_url = start_server(find_web_root())
        self.window = None
        self.exit_code = 0

    def do_activate(self):
        if not self.window:
            self.window = Window(self, self.base_url)
        self.window.present()

    def do_open(self, files, n_files, hint):
        self.do_activate()
        for f in files:
            if f.get_path():
                self.window.open_path(f.get_path())


def main():
    app = App()
    status = app.run(sys.argv)
    return app.exit_code or status


if __name__ == "__main__":
    sys.exit(main())
