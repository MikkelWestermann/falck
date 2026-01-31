use serde_json::{Map, Value};
use std::ffi::OsStr;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime, State};

pub struct OpencodeState(pub Mutex<Option<SidecarProcess>>);

impl Default for OpencodeState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

pub struct SidecarProcess {
    _child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

#[tauri::command]
pub fn opencode_send(
    app: AppHandle,
    state: State<OpencodeState>,
    cmd: String,
    args: Value,
) -> Result<Value, String> {
    let mut guard = state.0.lock().map_err(|_| "Sidecar lock poisoned".to_string())?;
    if guard.is_none() {
        *guard = Some(spawn_sidecar(&app)?);
    }

    let process = guard.as_mut().ok_or("Sidecar not available")?;
    let request = build_request(cmd, args)?;

    process
        .stdin
        .write_all(request.as_bytes())
        .map_err(|e| e.to_string())?;
    process.stdin.write_all(b"\n").map_err(|e| e.to_string())?;
    process.stdin.flush().map_err(|e| e.to_string())?;

    let mut response_line = String::new();
    let bytes_read = process
        .stdout
        .read_line(&mut response_line)
        .map_err(|e| e.to_string())?;

    if bytes_read == 0 {
        *guard = None;
        return Err("OpenCode sidecar exited unexpectedly".to_string());
    }

    let response: Value =
        serde_json::from_str(response_line.trim()).map_err(|e| e.to_string())?;

    match response.get("type").and_then(Value::as_str) {
        Some("success") => Ok(response.get("data").cloned().unwrap_or(Value::Null)),
        Some("error") => Err(response
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Unknown OpenCode error")
            .to_string()),
        _ => Err("Unexpected OpenCode response".to_string()),
    }
}

fn build_request(cmd: String, args: Value) -> Result<String, String> {
    let mut map = Map::new();
    map.insert("cmd".to_string(), Value::String(cmd));

    match args {
        Value::Null => {}
        Value::Object(obj) => {
            for (key, value) in obj {
                map.insert(key, value);
            }
        }
        _ => return Err("args must be an object".to_string()),
    }

    serde_json::to_string(&Value::Object(map)).map_err(|e| e.to_string())
}

fn spawn_sidecar<R: Runtime>(app: &AppHandle<R>) -> Result<SidecarProcess, String> {
    if let Ok(path) = std::env::var("OPENCODE_SIDECAR_PATH") {
        let path = PathBuf::from(path);
        if path.exists() {
            return spawn_process(path);
        }
    }

    if let Some(binary) = find_sidecar_binary(app) {
        return spawn_process(binary);
    }

    if let Some(script) = find_sidecar_script(app) {
        return spawn_bun(script);
    }

    Err(
        "OpenCode sidecar not found. Build it in sidecar-opencode/ and run rename.js."
            .to_string(),
    )
}

fn spawn_process(path: PathBuf) -> Result<SidecarProcess, String> {
    let mut child = Command::new(&path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("Failed to start sidecar at {}: {}", path.display(), e))?;

    let stdin = child.stdin.take().ok_or("Failed to open sidecar stdin")?;
    let stdout = child.stdout.take().ok_or("Failed to open sidecar stdout")?;

    Ok(SidecarProcess {
        _child: child,
        stdin,
        stdout: BufReader::new(stdout),
    })
}

fn spawn_bun(script: PathBuf) -> Result<SidecarProcess, String> {
    let mut child = Command::new("bun")
        .arg(script.as_os_str())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("Failed to start bun sidecar: {}", e))?;

    let stdin = child.stdin.take().ok_or("Failed to open sidecar stdin")?;
    let stdout = child.stdout.take().ok_or("Failed to open sidecar stdout")?;

    Ok(SidecarProcess {
        _child: child,
        stdin,
        stdout: BufReader::new(stdout),
    })
}

fn find_sidecar_binary<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        if let Some(found) = find_in_dir(&resource_dir) {
            return Some(found);
        }
        if let Some(found) = find_in_dir(&resource_dir.join("binaries")) {
            return Some(found);
        }
    }

    let cwd = std::env::current_dir().ok();
    let candidates = [
        cwd.as_ref().map(|dir| dir.join("binaries")),
        cwd.as_ref().map(|dir| dir.join("src-tauri").join("binaries")),
        cwd.as_ref().map(|dir| dir.join("..").join("src-tauri").join("binaries")),
    ];

    for candidate in candidates.into_iter().flatten() {
        if let Some(found) = find_in_dir(&candidate) {
            return Some(found);
        }
    }

    None
}

fn find_sidecar_script<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let cwd = std::env::current_dir().ok();
    let candidates = [
        cwd.as_ref().map(|dir| dir.join("sidecar-opencode").join("index.ts")),
        cwd.as_ref()
            .map(|dir| dir.join("..").join("sidecar-opencode").join("index.ts")),
    ];

    for candidate in candidates.into_iter().flatten() {
        if candidate.exists() {
            return Some(candidate);
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidate = resource_dir.join("sidecar-opencode").join("index.ts");
        if candidate.exists() {
            return Some(candidate);
        }
    }

    None
}

fn find_in_dir(dir: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if let Some(name) = path.file_name().and_then(OsStr::to_str) {
            if name.starts_with("opencode-sidecar-") {
                return Some(path);
            }
        }
    }
    None
}
