use serde::{Deserialize, Serialize};
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

#[derive(Debug, Serialize, Deserialize)]
pub struct OpenCodeStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

#[tauri::command]
pub fn check_opencode_installed() -> Result<OpenCodeStatus, String> {
    let output = Command::new("opencode").arg("--version").output();

    match output {
        Ok(result) if result.status.success() => {
            let stdout = String::from_utf8_lossy(&result.stdout);
            let stderr = String::from_utf8_lossy(&result.stderr);
            let combined = format!("{}\n{}", stdout, stderr);
            let version = combined
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map(str::to_string);
            let path = get_opencode_path().ok();

            Ok(OpenCodeStatus {
                installed: true,
                version,
                path,
            })
        }
        Ok(_) => Ok(OpenCodeStatus {
            installed: false,
            version: None,
            path: None,
        }),
        Err(err) => {
            if err.kind() == std::io::ErrorKind::NotFound {
                Ok(OpenCodeStatus {
                    installed: false,
                    version: None,
                    path: None,
                })
            } else {
                Err(format!("Failed to check OpenCode: {}", err))
            }
        }
    }
}

#[tauri::command]
pub async fn install_opencode() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(install_opencode_impl)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn check_command_exists(command: String) -> bool {
    command_exists(&command)
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

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn install_opencode_impl() -> Result<String, String> {
    let output = Command::new("bash")
        .arg("-c")
        .arg("curl -fsSL https://opencode.ai/install | bash")
        .output()
        .map_err(|e| format!("Failed to execute install script: {}", e))?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        Ok(format!("OpenCode installed successfully.\n{}", stdout))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Installation failed:\n{}", stderr))
    }
}

#[cfg(target_os = "windows")]
fn install_opencode_impl() -> Result<String, String> {
    Err("windows_manual_install".to_string())
}

fn get_opencode_path() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    let output = Command::new("where")
        .arg("opencode")
        .output()
        .map_err(|e| e.to_string())?;

    #[cfg(not(target_os = "windows"))]
    let output = Command::new("which")
        .arg("opencode")
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err("Could not find OpenCode path".to_string())
    }
}

fn command_exists(command: &str) -> bool {
    #[cfg(target_os = "windows")]
    let output = Command::new("where").arg(command).output();

    #[cfg(not(target_os = "windows"))]
    let output = Command::new("which").arg(command).output();

    output.map(|result| result.status.success()).unwrap_or(false)
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
