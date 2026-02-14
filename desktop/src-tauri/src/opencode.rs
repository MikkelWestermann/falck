use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::env;
use std::ffi::OsStr;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime, State};

use crate::falck::load_shell_env;

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
pub fn check_opencode_installed(app: AppHandle) -> Result<OpenCodeStatus, String> {
    let Some(path) = find_opencode_cli(&app) else {
        return Ok(OpenCodeStatus {
            installed: false,
            version: None,
            path: None,
        });
    };

    let output = Command::new(&path).arg("--version").output();
    let version = output
        .ok()
        .filter(|result| result.status.success())
        .and_then(|result| {
            let stdout = String::from_utf8_lossy(&result.stdout);
            let stderr = String::from_utf8_lossy(&result.stderr);
            let combined = format!("{}\n{}", stdout, stderr);
            combined
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map(str::to_string)
        });

    Ok(OpenCodeStatus {
        installed: true,
        version,
        path: Some(path.to_string_lossy().to_string()),
    })
}

#[tauri::command]
pub async fn install_opencode(app: AppHandle) -> Result<String, String> {
    if find_opencode_cli(&app).is_some() {
        return Ok("OpenCode is bundled with Falck.".to_string());
    }

    Err("OpenCode CLI bundle not found. Reinstall Falck or run the sidecar build.".to_string())
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
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "Sidecar lock poisoned".to_string())?;
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

    let response: Value = serde_json::from_str(response_line.trim()).map_err(|e| e.to_string())?;

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

fn apply_shell_env(cmd: &mut Command) {
    let Some(shell_env) = load_shell_env() else {
        return;
    };

    for (key, value) in shell_env {
        if key == "PATH" {
            cmd.env(&key, value);
            continue;
        }

        if env::var_os(&key).is_none() {
            cmd.env(&key, value);
        }
    }
}

fn command_exists(command: &str) -> bool {
    #[cfg(target_os = "windows")]
    let output = Command::new("where").arg(command).output();

    #[cfg(not(target_os = "windows"))]
    let output = Command::new("which").arg(command).output();

    output
        .map(|result| result.status.success())
        .unwrap_or(false)
}

fn spawn_sidecar<R: Runtime>(app: &AppHandle<R>) -> Result<SidecarProcess, String> {
    let cli_path = find_opencode_cli(app);

    if let Ok(path) = std::env::var("OPENCODE_SIDECAR_PATH") {
        let path = PathBuf::from(path);
        if path.exists() {
            return spawn_process(path, cli_path.as_deref());
        }
    }

    if let Some(binary) = find_sidecar_binary(app) {
        return spawn_process(binary, cli_path.as_deref());
    }

    if let Some(script) = find_sidecar_script(app) {
        return spawn_bun(script, cli_path.as_deref());
    }

    Err(
        "OpenCode sidecar not found. Build it in sidecar-opencode/ and ensure it is in src-tauri/sidecars."
            .to_string(),
    )
}

fn spawn_process(path: PathBuf, cli_path: Option<&Path>) -> Result<SidecarProcess, String> {
    let mut cmd = Command::new(&path);
    apply_shell_env(&mut cmd);
    if let Some(cli_path) = cli_path {
        cmd.env("OPENCODE_CLI_PATH", cli_path);
    }

    let mut child = cmd
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

fn spawn_bun(script: PathBuf, cli_path: Option<&Path>) -> Result<SidecarProcess, String> {
    let mut cmd = Command::new("bun");
    apply_shell_env(&mut cmd);
    if let Some(cli_path) = cli_path {
        cmd.env("OPENCODE_CLI_PATH", cli_path);
    }

    let mut child = cmd
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
    if let Ok(current) = tauri::process::current_binary(&app.env()) {
        if let Some(parent) = current.parent() {
            if let Some(found) = find_named_in_dir(parent, "opencode-sidecar") {
                return Some(found);
            }
            if let Some(found) = find_named_in_dir(&parent.join("sidecars"), "opencode-sidecar") {
                return Some(found);
            }
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        if let Some(found) = find_named_in_dir(&resource_dir, "opencode-sidecar") {
            return Some(found);
        }
        if let Some(found) = find_named_in_dir(&resource_dir.join("binaries"), "opencode-sidecar") {
            return Some(found);
        }
        if let Some(found) = find_named_in_dir(&resource_dir.join("sidecars"), "opencode-sidecar") {
            return Some(found);
        }
    }

    let cwd = std::env::current_dir().ok();
    let candidates = [
        cwd.as_ref().map(|dir| dir.join("sidecars")),
        cwd.as_ref()
            .map(|dir| dir.join("src-tauri").join("sidecars")),
        cwd.as_ref()
            .map(|dir| dir.join("..").join("src-tauri").join("sidecars")),
        cwd.as_ref().map(|dir| dir.join("binaries")),
        cwd.as_ref()
            .map(|dir| dir.join("src-tauri").join("binaries")),
        cwd.as_ref()
            .map(|dir| dir.join("..").join("src-tauri").join("binaries")),
    ];

    for candidate in candidates.into_iter().flatten() {
        if let Some(found) = find_named_in_dir(&candidate, "opencode-sidecar") {
            return Some(found);
        }
    }

    None
}

fn find_sidecar_script<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let cwd = std::env::current_dir().ok();
    let candidates = [
        cwd.as_ref()
            .map(|dir| dir.join("sidecar-opencode").join("index.ts")),
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

fn find_opencode_cli<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    if let Ok(path) = std::env::var("OPENCODE_CLI_PATH") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Some(path);
        }
    }

    if let Ok(current) = tauri::process::current_binary(&app.env()) {
        if let Some(parent) = current.parent() {
            if let Some(found) = find_named_in_dir(parent, "opencode-cli") {
                return Some(found);
            }
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        if let Some(found) = find_named_in_dir(&resource_dir, "opencode-cli") {
            return Some(found);
        }
        if let Some(found) = find_named_in_dir(&resource_dir.join("sidecars"), "opencode-cli") {
            return Some(found);
        }
    }

    let cwd = std::env::current_dir().ok();
    let candidates = [
        cwd.as_ref().map(|dir| dir.join("sidecars")),
        cwd.as_ref()
            .map(|dir| dir.join("src-tauri").join("sidecars")),
        cwd.as_ref()
            .map(|dir| dir.join("..").join("src-tauri").join("sidecars")),
    ];

    for candidate in candidates.into_iter().flatten() {
        if let Some(found) = find_named_in_dir(&candidate, "opencode-cli") {
            return Some(found);
        }
    }

    None
}

fn find_named_in_dir(dir: &Path, prefix: &str) -> Option<PathBuf> {
    let direct = dir.join(prefix);
    if direct.exists() {
        return Some(direct);
    }

    let exe = dir.join(format!("{prefix}.exe"));
    if exe.exists() {
        return Some(exe);
    }

    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if let Some(name) = path.file_name().and_then(OsStr::to_str) {
            if name.starts_with(prefix) {
                return Some(path);
            }
        }
    }

    None
}
