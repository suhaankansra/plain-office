// Plain Office for Windows.
//
// A Tauri window around the Plain Office web app (../dist, built into the
// app). Windows 11 gets its Mica material behind the page, which the app's
// glass look shows through. The page talks to this side through two things:
//   - window.plainOffice (src/main.js): we call it to open files from Explorer
//   - the save_file command (src/files.js): shows a Save dialog and writes the file
// Nothing here or in the page connects to the internet.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

// Files to open once the page has loaded.
#[derive(Default)]
struct Opened {
    loaded: Mutex<bool>,
    pending: Mutex<Vec<PathBuf>>,
}

fn file_args(args: &[String]) -> Vec<PathBuf> {
    args.iter().map(PathBuf::from).filter(|p| p.is_file()).collect()
}

fn open_files(app: &AppHandle, files: Vec<PathBuf>) {
    let state = app.state::<Opened>();
    if !*state.loaded.lock().unwrap() {
        state.pending.lock().unwrap().extend(files);
        return;
    }
    let Some(window) = app.get_webview_window("main") else { return };
    for path in files {
        send_file(&window, &path);
    }
    let _ = window.unminimize();
    let _ = window.set_focus();
}

fn send_file(window: &WebviewWindow, path: &PathBuf) {
    let Ok(bytes) = std::fs::read(path) else { return };
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "document".into());
    let js = format!(
        "window.plainOffice?.open({}, {})",
        serde_json::to_string(&b64).unwrap(),
        serde_json::to_string(&name).unwrap()
    );
    let _ = window.eval(&js);
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(value) = u8::from_str_radix(&text[i + 1..i + 3], 16) {
                out.push(value);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// "Save a copy": the page sends the file's bytes; ask where to put them.
#[tauri::command]
async fn save_file(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<Option<String>, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("No file to save".into());
    };
    let name = request
        .headers()
        .get("x-file-name")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .unwrap_or_else(|| "document".into());
    let mut dialog = app.dialog().file().set_file_name(&name);
    if let Some(ext) = std::path::Path::new(&name).extension().and_then(|e| e.to_str()) {
        dialog = dialog.add_filter(format!("{} file", ext.to_uppercase()), &[ext]);
    }
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    let Some(path) = dialog.blocking_save_file() else { return Ok(None) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| format!("Could not save: {e}"))?;
    Ok(path.file_name().map(|n| n.to_string_lossy().into_owned()))
}

// Windows 11 (build 22000+) has Mica; Windows 10 gets a normal solid window.
#[cfg(windows)]
fn has_mica() -> bool {
    windows_version::OsVersion::current().build >= 22000
}
#[cfg(not(windows))]
fn has_mica() -> bool {
    false
}

fn main() {
    tauri::Builder::default()
        // A second launch (double-clicking another file) hands its files to this window.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            open_files(app, file_args(args.get(1..).unwrap_or_default()));
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(Opened::default())
        .invoke_handler(tauri::generate_handler![save_file])
        .setup(|app| {
            let args: Vec<String> = std::env::args().skip(1).collect();
            app.state::<Opened>().pending.lock().unwrap().extend(file_args(&args));

            let mica = has_mica();
            let host = format!(
                "window.plainOfficeHost = Object.freeze({{ os: 'windows', version: {}, mica: {} }});",
                serde_json::to_string(&app.package_info().version.to_string()).unwrap(),
                mica
            );
            let handle = app.handle().clone();
            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Plain Office")
                .inner_size(1180.0, 800.0)
                .min_inner_size(640.0, 480.0)
                .center()
                .initialization_script(&host)
                // Stay inside the app: no browsing to websites.
                .on_navigation(|url| {
                    matches!(url.scheme(), "tauri" | "blob" | "data" | "about")
                        || url.host_str() == Some("tauri.localhost")
                })
                .on_page_load(move |window, payload| {
                    if payload.event() != PageLoadEvent::Finished {
                        return;
                    }
                    let state = handle.state::<Opened>();
                    *state.loaded.lock().unwrap() = true;
                    let files: Vec<PathBuf> = state.pending.lock().unwrap().drain(..).collect();
                    for path in files {
                        send_file(&window, &path);
                    }
                });
            #[cfg(windows)]
            let builder = if mica {
                use tauri::window::{Effect, EffectsBuilder};
                builder.transparent(true).effects(EffectsBuilder::new().effect(Effect::Mica).build())
            } else {
                builder
            };
            builder.build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Plain Office could not start");
}
