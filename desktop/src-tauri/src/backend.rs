use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

use crate::blocking::run_blocking;
pub use crate::storage::BackendMode;
use crate::storage::{self};

static VM_OP_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static VM_ENSURE_INFLIGHT: OnceLock<Mutex<HashMap<String, Arc<EnsureInFlight>>>> = OnceLock::new();
const VM_SHELL_TIMEOUT_SECS: u32 = 20;
const VM_START_TIMEOUT_SECS: u32 = 120;
const VM_CREATE_TIMEOUT_SECS: u32 = 180;
const VM_BOOTSTRAP_TIMEOUT_SECS: u32 = 240;

#[derive(Debug, Serialize, Clone)]
struct VmStatusEvent {
    repo_path: String,
    vm_name: Option<String>,
    provider: Option<String>,
    phase: String,
    message: String,
    timestamp_ms: u64,
}

#[derive(Debug)]
struct EnsureInFlight {
    state: Mutex<EnsureState>,
    cvar: Condvar,
}

#[derive(Debug, Clone)]
enum EnsureState {
    Running,
    Done(Result<String, String>),
}

impl EnsureInFlight {
    fn new() -> Self {
        Self {
            state: Mutex::new(EnsureState::Running),
            cvar: Condvar::new(),
        }
    }

    fn wait(&self) -> Result<String, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "VM ensure state poisoned.".to_string())?;
        loop {
            match &*state {
                EnsureState::Done(result) => return result.clone(),
                EnsureState::Running => {
                    state = self
                        .cvar
                        .wait(state)
                        .map_err(|_| "VM ensure state poisoned.".to_string())?;
                }
            }
        }
    }

    fn finish(&self, result: Result<String, String>) {
        if let Ok(mut state) = self.state.lock() {
            *state = EnsureState::Done(result);
            self.cvar.notify_all();
        }
    }
}

fn provider_id(provider: VmProvider) -> &'static str {
    match provider {
        VmProvider::Lima => "lima",
        VmProvider::Wsl => "wsl",
    }
}

fn emit_vm_status(
    app: Option<&AppHandle>,
    repo_path: &Path,
    name: Option<&str>,
    provider: Option<VmProvider>,
    phase: &str,
    message: &str,
) {
    let Some(app) = app else {
        return;
    };
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let payload = VmStatusEvent {
        repo_path: repo_path.to_string_lossy().to_string(),
        vm_name: name.map(|value| value.to_string()),
        provider: provider.map(|value| provider_id(value).to_string()),
        phase: phase.to_string(),
        message: message.to_string(),
        timestamp_ms,
    };
    let _ = app.emit("vm:status", payload);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VmProvider {
    Lima,
    Wsl,
}

#[derive(Debug, Clone)]
pub struct VmContext {
    pub provider: VmProvider,
    pub name: String,
    pub repo_path: PathBuf,
    pub repo_root: String,
}

#[derive(Debug, Clone)]
pub struct VmProcessHandle {
    pub provider: VmProvider,
    pub name: String,
}

#[derive(Debug, Clone)]
pub enum BackendProcess {
    Host { pid: u32 },
    Virtualized { pid: u32, vm: VmProcessHandle },
}

#[derive(Debug, Clone)]
pub struct BackendContext {
    pub mode: BackendMode,
    pub vm: Option<VmContext>,
}

impl BackendContext {
    pub fn host() -> Self {
        BackendContext {
            mode: BackendMode::Host,
            vm: None,
        }
    }
}

#[derive(Debug, Serialize, Clone)]
pub struct BackendPrereqStatus {
    pub installed: bool,
    pub tool: String,
    pub message: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct BackendEnsureResult {
    pub mode: BackendMode,
    pub vm_name: Option<String>,
    pub provider: Option<String>,
}

fn vm_provider() -> Result<VmProvider, String> {
    if cfg!(target_os = "windows") {
        Ok(VmProvider::Wsl)
    } else if cfg!(target_os = "macos") || cfg!(target_os = "linux") {
        Ok(VmProvider::Lima)
    } else {
        Err("Virtualized backend not supported on this OS.".to_string())
    }
}

fn tool_name(provider: VmProvider) -> &'static str {
    match provider {
        VmProvider::Lima => "Lima",
        VmProvider::Wsl => "WSL",
    }
}

fn apply_shell_env(cmd: &mut Command) {
    if let Some(shell_env) = crate::falck::load_shell_env() {
        if let Some(path) = shell_env.get("PATH") {
            cmd.env("PATH", path);
        }
    }
}

fn vm_lock() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    VM_OP_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "VM operation lock poisoned.".to_string())
}

fn command_exists(command: &str) -> bool {
    #[cfg(target_os = "windows")]
    let output = {
        let mut cmd = Command::new("where");
        cmd.arg(command);
        apply_shell_env(&mut cmd);
        cmd.output()
    };

    #[cfg(not(target_os = "windows"))]
    let output = {
        let mut cmd = Command::new("which");
        cmd.arg(command);
        apply_shell_env(&mut cmd);
        cmd.output()
    };

    output
        .map(|result| result.status.success())
        .unwrap_or(false)
}

fn check_wsl_available() -> bool {
    if !command_exists("wsl") {
        return false;
    }
    let status = {
        let mut cmd = Command::new("wsl");
        cmd.arg("--status");
        apply_shell_env(&mut cmd);
        cmd.status()
    };
    if status.map(|result| result.success()).unwrap_or(false) {
        return true;
    }
    let status = {
        let mut cmd = Command::new("wsl");
        cmd.args(["-l", "-q"]);
        apply_shell_env(&mut cmd);
        cmd.status()
    };
    status.map(|result| result.success()).unwrap_or(false)
}

fn ensure_prereq(provider: VmProvider) -> Result<(), String> {
    let installed = match provider {
        VmProvider::Lima => command_exists("limactl"),
        VmProvider::Wsl => check_wsl_available(),
    };
    if installed {
        Ok(())
    } else {
        Err(format!(
            "{} is not installed. Configure it in Settings to enable the virtualized backend.",
            tool_name(provider)
        ))
    }
}

fn ensure_vm_bootstrap(provider: VmProvider, name: &str) -> Result<(), String> {
    let vm = VmContext {
        provider,
        name: name.to_string(),
        repo_path: PathBuf::new(),
        repo_root: "/".to_string(),
    };
    let script = format!(
        r#"
set -e
echo "[falck] bootstrap start" >&2
if [ -f /var/lib/falck/bootstrap_v1 ]; then
  exit 0
fi
if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  if ! command -v sudo >/dev/null 2>&1; then
    echo "sudo is required to install base packages inside the VM." >&2
    exit 1
  fi
  if ! sudo -n true >/dev/null 2>&1; then
    echo "sudo requires a password. Run: limactl shell {name} -- sudo -v" >&2
    exit 1
  fi
  SUDO="sudo -n"
fi
$SUDO mkdir -p /var/lib/falck
if command -v apt-get >/dev/null 2>&1; then
  $SUDO DEBIAN_FRONTEND=noninteractive apt-get -y -o Dpkg::Lock::Timeout=60 update
  $SUDO DEBIAN_FRONTEND=noninteractive apt-get -y -o Dpkg::Lock::Timeout=60 install unzip zip git curl ca-certificates rsync
elif command -v dnf >/dev/null 2>&1; then
  $SUDO dnf -y install unzip zip git curl ca-certificates rsync
elif command -v apk >/dev/null 2>&1; then
  $SUDO apk add --no-cache unzip zip git curl ca-certificates rsync
else
  echo "No supported package manager found on VM." >&2
  exit 1
fi
$SUDO touch /var/lib/falck/bootstrap_v1
"#,
        name = name
    );
    let cmd = build_vm_command(&vm, &script);
    let (status, stdout, stderr) =
        spawn_capture_with_timeout(cmd, Some(VM_BOOTSTRAP_TIMEOUT_SECS))
            .map_err(|e| format!("Failed to bootstrap VM packages: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        let stdout_len = stdout.len();
        let stderr_len = stderr.len();
        let combined = format!("{}\n{}", stdout.trim(), stderr.trim()).trim().to_string();
        if combined.is_empty() {
            let code = status
                .code()
                .map(|value| value.to_string())
                .unwrap_or_else(|| "unknown".to_string());
            let mut message = format!(
                "Failed to install required VM packages (exit {code}, stdout {stdout_len} bytes, stderr {stderr_len} bytes)."
            );
            if provider == VmProvider::Lima {
                if let Some(logs) = lima_debug_logs(&vm.name) {
                    message.push_str("\n\nLima logs:\n");
                    message.push_str(&logs);
                } else {
                    message.push_str("\n\nLima logs: (none found)");
                }
            }
            eprintln!("[falck][backend] bootstrap failed: {}", message);
            Err(message)
        } else {
            eprintln!("[falck][backend] bootstrap failed: {}", combined);
            Err(combined)
        }
    }
}

fn install_prereq(provider: VmProvider) -> Result<String, String> {
    match provider {
        VmProvider::Lima => {
            if !command_exists("brew") {
                return Err("Homebrew not found. Install Lima manually or install Homebrew first.".to_string());
            }
            let status = {
                let mut cmd = Command::new("brew");
                cmd.args(["install", "lima"]);
                apply_shell_env(&mut cmd);
                cmd.status()
            }
                .map_err(|e| format!("Failed to run brew: {e}"))?;
            if status.success() {
                Ok("Lima installed via Homebrew.".to_string())
            } else {
                Err("Homebrew failed to install Lima.".to_string())
            }
        }
        VmProvider::Wsl => {
            let status = {
                let mut cmd = Command::new("wsl");
                cmd.arg("--install");
                apply_shell_env(&mut cmd);
                cmd.status()
            }
                .map_err(|e| format!("Failed to run wsl --install: {e}"))?;
            if status.success() {
                Ok("WSL installation started. Windows may require a restart.".to_string())
            } else {
                Err("WSL installation failed.".to_string())
            }
        }
    }
}

fn fnv1a_hash(value: &str) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in value.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn sanitize_name(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut last_dash = false;
    for ch in value.chars() {
        let allowed = ch.is_ascii_alphanumeric();
        if allowed {
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "repo".to_string()
    } else {
        trimmed
    }
}

fn vm_name_for_repo(repo_path: &Path) -> String {
    let base = repo_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("repo");
    let hash = fnv1a_hash(&repo_path.to_string_lossy());
    let suffix = format!("{:08x}", (hash & 0xffff_ffff) as u32);
    format!("falck-{}-{}", sanitize_name(base), suffix)
}

fn lima_mount_target(repo_path: &Path) -> String {
    let base = repo_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("repo");
    let hash = fnv1a_hash(&repo_path.to_string_lossy());
    let suffix = format!("{:08x}", (hash & 0xffff_ffff) as u32);
    format!("/mnt/falck-{}-{}", sanitize_name(base), suffix)
}

fn yq_quote(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| format!("\"{}\"", value.replace('\"', "\\\"")))
}

fn lima_mounts_yq(repo_path: &Path) -> String {
    let repo_location = repo_path.to_string_lossy().replace('\\', "/");
    let repo_mount = lima_mount_target(repo_path);
    let home_location = yq_quote("~");
    let repo_location = yq_quote(&repo_location);
    let repo_mount = yq_quote(&repo_mount);
    format!(
        ".mounts = [{{\"location\": {home}}}, {{\"location\": {repo}, \"mountPoint\": {mount}, \"writable\": true}}]",
        home = home_location,
        repo = repo_location,
        mount = repo_mount
    )
}

fn lima_legacy_mount_target(repo_path: &Path) -> String {
    let base = repo_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("repo");
    let hash = fnv1a_hash(&repo_path.to_string_lossy());
    let suffix = format!("{:08x}", (hash & 0xffff_ffff) as u32);
    format!("/mnt/falck/{}-{}", sanitize_name(base), suffix)
}

fn lima_instance_dir(name: &str) -> Option<PathBuf> {
    std::env::var("HOME")
        .ok()
        .map(|home| PathBuf::from(home).join(".lima").join(name))
}

#[derive(Debug, Deserialize)]
struct LimaListEntry {
    name: String,
}

fn lima_instance_registered(name: &str) -> bool {
    let output = {
        let mut cmd = Command::new("limactl");
        cmd.args(["list", "--json", "--tty=false"]);
        apply_shell_env(&mut cmd);
        cmd.output()
    };
    let Ok(output) = output else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    serde_json::from_slice::<Vec<LimaListEntry>>(&output.stdout)
        .map(|items| items.iter().any(|item| item.name == name))
        .unwrap_or(false)
}

fn cleanup_stale_lima_instance(name: &str) -> Result<(), String> {
    let Some(dir) = lima_instance_dir(name) else {
        return Ok(());
    };
    if !dir.exists() {
        return Ok(());
    }
    fs::remove_dir_all(&dir).map_err(|err| {
        format!(
            "Failed to remove stale VM directory {}: {err}",
            dir.display()
        )
    })
}

fn tail_file(path: &Path, max_bytes: usize) -> Option<String> {
    let data = fs::read(path).ok()?;
    if data.is_empty() {
        return None;
    }
    let slice = if data.len() > max_bytes {
        &data[data.len() - max_bytes..]
    } else {
        &data
    };
    Some(String::from_utf8_lossy(slice).to_string())
}

fn lima_debug_logs(name: &str) -> Option<String> {
    let dir = lima_instance_dir(name)?;
    let mut sections = Vec::new();
    for file in [
        "ha.stderr.log",
        "ha.stdout.log",
        "serial0.log",
        "serial.log",
        "lima.log",
    ] {
        let path = dir.join(file);
        if let Some(content) = tail_file(&path, 16_384) {
            let mut block = String::new();
            block.push_str(&format!("--- {} ---\n", file));
            block.push_str(content.trim_end());
            sections.push(block);
        }
    }
    if sections.is_empty() {
        None
    } else {
        Some(sections.join("\n\n"))
    }
}

fn windows_path_to_wsl(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let trimmed = raw.trim();
    if trimmed.len() >= 2 && trimmed.as_bytes()[1] == b':' {
        let drive = trimmed
            .chars()
            .next()
            .unwrap_or('c')
            .to_ascii_lowercase();
        let mut rest = trimmed[2..].replace('\\', "/");
        rest = rest.trim_start_matches('/').to_string();
        if rest.is_empty() {
            format!("/mnt/{}", drive)
        } else {
            format!("/mnt/{}/{}", drive, rest)
        }
    } else {
        trimmed.replace('\\', "/")
    }
}

fn join_unix(base: &str, rel: &str) -> String {
    let base_trimmed = base.trim_end_matches('/');
    let rel_trimmed = rel.trim_start_matches('/');
    if rel_trimmed.is_empty() {
        base_trimmed.to_string()
    } else {
        format!("{}/{}", base_trimmed, rel_trimmed)
    }
}

fn get_vm_home(provider: VmProvider, name: &str) -> Result<String, String> {
    let cmd = match provider {
        VmProvider::Lima => {
            let mut cmd = Command::new("limactl");
            cmd.args([
                "shell",
                "--tty=false",
                name,
                "--",
                "sh",
                "-c",
                "printf %s \"$HOME\"",
            ]);
            apply_shell_env(&mut cmd);
            cmd
        }
        VmProvider::Wsl => {
            let mut cmd = Command::new("wsl");
            cmd.args(["-d", name, "--", "sh", "-c", "printf %s \"$HOME\""]);
            apply_shell_env(&mut cmd);
            cmd
        }
    };
    let (status, stdout, _stderr) =
        spawn_capture_with_timeout(cmd, Some(VM_SHELL_TIMEOUT_SECS))
            .map_err(|e| format!("Failed to read VM home directory: {e}"))?;
    if !status.success() {
        return Err("Failed to read VM home directory.".to_string());
    }
    let home = stdout.trim().to_string();
    if home.is_empty() {
        Err("VM home directory not available.".to_string())
    } else {
        Ok(home)
    }
}

fn path_exists_in_vm(provider: VmProvider, name: &str, path: &str) -> bool {
    let vm = VmContext {
        provider,
        name: name.to_string(),
        repo_path: PathBuf::new(),
        repo_root: "/".to_string(),
    };
    let script = format!("test -d {} && echo ok", shell_escape(path));
    let output = spawn_capture_with_timeout(build_vm_command(&vm, &script), Some(VM_SHELL_TIMEOUT_SECS));
    output.map(|(status, _stdout, _stderr)| status.success()).unwrap_or(false)
}

fn path_exists_in_vm_with_retry(
    provider: VmProvider,
    name: &str,
    path: &str,
    retries: u32,
    delay_ms: u64,
) -> bool {
    for attempt in 0..=retries {
        if path_exists_in_vm(provider, name, path) {
            return true;
        }
        if attempt < retries {
            std::thread::sleep(Duration::from_millis(delay_ms));
        }
    }
    false
}

fn path_writable_in_vm(provider: VmProvider, name: &str, path: &str) -> bool {
    let vm = VmContext {
        provider,
        name: name.to_string(),
        repo_path: PathBuf::new(),
        repo_root: "/".to_string(),
    };
    let script = format!(
        "p={}; test -d \"$p\" && tmp=\"$p/.falck_write_test_$$\" && (echo test > \"$tmp\") >/dev/null 2>&1 && rm -f \"$tmp\"",
        shell_escape(path)
    );
    let output = spawn_capture_with_timeout(build_vm_command(&vm, &script), Some(VM_SHELL_TIMEOUT_SECS));
    output.map(|(status, _stdout, _stderr)| status.success()).unwrap_or(false)
}

fn path_writable_in_vm_with_retry(
    provider: VmProvider,
    name: &str,
    path: &str,
    retries: u32,
    delay_ms: u64,
) -> bool {
    for attempt in 0..=retries {
        if path_writable_in_vm(provider, name, path) {
            return true;
        }
        if attempt < retries {
            std::thread::sleep(Duration::from_millis(delay_ms));
        }
    }
    false
}

fn resolve_repo_root(provider: VmProvider, name: &str, repo_path: &Path) -> Result<String, String> {
    match provider {
        VmProvider::Wsl => Ok(windows_path_to_wsl(repo_path)),
        VmProvider::Lima => {
            let preferred = lima_mount_target(repo_path);
            if path_exists_in_vm_with_retry(provider, name, &preferred, 5, 700) {
                if !path_writable_in_vm_with_retry(provider, name, &preferred, 5, 700) {
                    return Err(format!(
                        "The VM mount for this repo is read-only. Use Settings > Reset VM (or `limactl delete {name}`) and try again."
                    ));
                }
                return Ok(preferred);
            }
            let legacy = lima_legacy_mount_target(repo_path);
            if path_exists_in_vm_with_retry(provider, name, &legacy, 5, 700) {
                if !path_writable_in_vm_with_retry(provider, name, &legacy, 5, 700) {
                    return Err(format!(
                        "The VM mount for this repo is read-only. Use Settings > Reset VM (or `limactl delete {name}`) and try again."
                    ));
                }
                return Ok(legacy);
            }
            let host_home = std::env::var("HOME").ok().map(PathBuf::from);
            let host_path = repo_path.to_string_lossy().replace('\\', "/");
            if let Some(home) = host_home {
                if repo_path.starts_with(&home) {
                    let rel = repo_path
                        .strip_prefix(&home)
                        .unwrap_or(repo_path)
                        .to_string_lossy()
                        .replace('\\', "/");
                    let vm_home = get_vm_home(provider, name)?;
                    let candidate = join_unix(&vm_home, &rel);
                    if path_exists_in_vm_with_retry(provider, name, &candidate, 5, 700) {
                        if !path_writable_in_vm_with_retry(provider, name, &candidate, 5, 700) {
                            return Err(format!(
                                "The VM mount for this repo is read-only. Use Settings > Reset VM (or `limactl delete {name}`) and try again."
                            ));
                        }
                        return Ok(candidate);
                    }
                }
            }
            if path_exists_in_vm_with_retry(provider, name, &host_path, 5, 700) {
                if !path_writable_in_vm_with_retry(provider, name, &host_path, 5, 700) {
                    return Err(format!(
                        "The VM mount for this repo is read-only. Use Settings > Reset VM (or `limactl delete {name}`) and try again."
                    ));
                }
                return Ok(host_path);
            }
            Err(format!(
                "The repo path is not mounted inside the VM. Use Settings > Reset VM (or `limactl delete {name}`) and try again."
            ))
        }
    }
}

fn limactl_start(name: &str, repo_path: Option<&Path>) -> Result<(), String> {
    let cmd = {
        let mut cmd = Command::new("limactl");
        cmd.args(["start", "--tty=false"]);
        if let Some(repo_path) = repo_path {
            let mounts_expr = lima_mounts_yq(repo_path);
            cmd.args(["--set", &mounts_expr]);
        }
        cmd.arg(name);
        apply_shell_env(&mut cmd);
        cmd
    };
    let (status, stdout, stderr) =
        spawn_capture_with_timeout(cmd, Some(VM_START_TIMEOUT_SECS))
            .map_err(|e| format!("Failed to start Lima VM: {e}"))?;

    if status.success() {
        return Ok(());
    }

    let combined = format!("{}\n{}", stdout.trim(), stderr.trim()).trim().to_string();
    if combined.to_ascii_lowercase().contains("already running") {
        return Ok(());
    }
    if combined.is_empty() {
        Err("Lima failed to start the virtual machine.".to_string())
    } else {
        Err(combined)
    }
}

fn limactl_create(name: &str, repo_path: &Path) -> Result<(), String> {
    let mounts_expr = lima_mounts_yq(repo_path);
    let cmd = {
        let mut cmd = Command::new("limactl");
        cmd.args([
            "create",
            "--tty=false",
            "--name",
            name,
            "--set",
            &mounts_expr,
            "template:default",
        ]);
        apply_shell_env(&mut cmd);
        cmd
    };
    let (status, stdout, stderr) =
        spawn_capture_with_timeout(cmd, Some(VM_CREATE_TIMEOUT_SECS))
            .map_err(|e| format!("Failed to create Lima VM: {e}"))?;

    if status.success() {
        return Ok(());
    }

    let combined = format!("{}\n{}", stdout.trim(), stderr.trim()).trim().to_string();
    if combined.is_empty() {
        Err("Lima failed to create the virtual machine.".to_string())
    } else {
        Err(combined)
    }
}

fn wait_for_vm_ready(provider: VmProvider, name: &str, timeout_secs: u32) -> Result<(), String> {
    let start = Instant::now();
    let timeout = Duration::from_secs(timeout_secs as u64);
    loop {
        let status = match provider {
            VmProvider::Lima => {
                let mut cmd = Command::new("limactl");
                cmd.args(["shell", "--tty=false", name, "--", "sh", "-c", "true"]);
                apply_shell_env(&mut cmd);
                spawn_with_timeout(cmd, Some(VM_SHELL_TIMEOUT_SECS), true).ok()
            }
            VmProvider::Wsl => {
                let mut cmd = Command::new("wsl");
                cmd.args(["-d", name, "--", "sh", "-c", "true"]);
                apply_shell_env(&mut cmd);
                spawn_with_timeout(cmd, Some(VM_SHELL_TIMEOUT_SECS), true).ok()
            }
        };
        if status.map(|result| result.success()).unwrap_or(false) {
            return Ok(());
        }
        if start.elapsed() > timeout {
            return Err("Timed out waiting for VM to become ready.".to_string());
        }
        std::thread::sleep(Duration::from_millis(1000));
    }
}

fn ensure_vm_running(
    provider: VmProvider,
    repo_path: &Path,
    app: Option<&AppHandle>,
) -> Result<String, String> {
    let key = repo_path.to_string_lossy().to_string();
    let (entry, leader) = {
        let map = VM_ENSURE_INFLIGHT
            .get_or_init(|| Mutex::new(HashMap::new()));
        let mut map = map
            .lock()
            .map_err(|_| "VM ensure lock poisoned.".to_string())?;
        if let Some(entry) = map.get(&key) {
            (entry.clone(), false)
        } else {
            let entry = Arc::new(EnsureInFlight::new());
            map.insert(key.clone(), entry.clone());
            (entry, true)
        }
    };

    if !leader {
        return entry.wait();
    }

    let result = ensure_vm_running_inner(provider, repo_path, app);
    entry.finish(result.clone());
    if let Ok(mut map) = VM_ENSURE_INFLIGHT
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    {
        map.remove(&key);
    }
    result
}

fn ensure_vm_running_inner(
    provider: VmProvider,
    repo_path: &Path,
    app: Option<&AppHandle>,
) -> Result<String, String> {
    let name = vm_name_for_repo(repo_path);
    emit_vm_status(
        app,
        repo_path,
        Some(&name),
        Some(provider),
        "starting",
        "Preparing virtualized backend",
    );
    emit_vm_status(
        app,
        repo_path,
        Some(&name),
        Some(provider),
        "checking",
        "Checking virtualization prerequisite",
    );
    if let Err(err) = ensure_prereq(provider) {
        emit_vm_status(
            app,
            repo_path,
            Some(&name),
            Some(provider),
            "error",
            &format!("Prerequisite check failed: {err}"),
        );
        return Err(err);
    }
    emit_vm_status(
        app,
        repo_path,
        Some(&name),
        Some(provider),
        "starting",
        "Waiting for VM lock",
    );
    let _guard = vm_lock().map_err(|err| {
        emit_vm_status(
            app,
            repo_path,
            Some(&name),
            Some(provider),
            "error",
            &format!("VM lock failed: {err}"),
        );
        err
    })?;
    emit_vm_status(
        app,
        repo_path,
        Some(&name),
        Some(provider),
        "starting",
        "VM lock acquired",
    );

    match provider {
        VmProvider::Lima => {
            emit_vm_status(
                app,
                repo_path,
                Some(&name),
                Some(provider),
                "starting",
                &format!("Starting Lima VM {}", name),
            );
            if limactl_start(&name, Some(repo_path)).is_ok() {
                emit_vm_status(
                    app,
                    repo_path,
                    Some(&name),
                    Some(provider),
                    "waiting",
                    "Waiting for VM to become ready",
                );
                wait_for_vm_ready(provider, &name, 90).map_err(|err| {
                    emit_vm_status(
                        app,
                        repo_path,
                        Some(&name),
                        Some(provider),
                        "error",
                        &format!("VM did not become ready: {err}"),
                    );
                    err
                })?;
                emit_vm_status(
                    app,
                    repo_path,
                    Some(&name),
                    Some(provider),
                    "bootstrapping",
                    "Installing base VM packages",
                );
                ensure_vm_bootstrap(provider, &name).map_err(|err| {
                    emit_vm_status(
                        app,
                        repo_path,
                        Some(&name),
                        Some(provider),
                        "error",
                        &format!("VM bootstrap failed: {err}"),
                    );
                    err
                })?;
                return Ok(name);
            }

            if lima_instance_registered(&name) {
                emit_vm_status(
                    app,
                    repo_path,
                    Some(&name),
                    Some(provider),
                    "starting",
                    "Existing VM found, restarting",
                );
                let _ = stop_vm_inner(provider, &name);
                if let Err(err) = limactl_start(&name, Some(repo_path)) {
                    emit_vm_status(
                        app,
                        repo_path,
                        Some(&name),
                        Some(provider),
                        "error",
                        &format!("Failed to start VM: {err}"),
                    );
                    return Err(format!(
                        "Lima failed to start the virtual machine: {}",
                        err
                    ));
                }
                emit_vm_status(
                    app,
                    repo_path,
                    Some(&name),
                    Some(provider),
                    "waiting",
                    "Waiting for VM to become ready",
                );
                wait_for_vm_ready(provider, &name, 90).map_err(|err| {
                    emit_vm_status(
                        app,
                        repo_path,
                        Some(&name),
                        Some(provider),
                        "error",
                        &format!("VM did not become ready: {err}"),
                    );
                    err
                })?;
                emit_vm_status(
                    app,
                    repo_path,
                    Some(&name),
                    Some(provider),
                    "bootstrapping",
                    "Installing base VM packages",
                );
                ensure_vm_bootstrap(provider, &name).map_err(|err| {
                    emit_vm_status(
                        app,
                        repo_path,
                        Some(&name),
                        Some(provider),
                        "error",
                        &format!("VM bootstrap failed: {err}"),
                    );
                    err
                })?;
                return Ok(name);
            }

            if let Some(dir) = lima_instance_dir(&name) {
                if dir.exists() {
                    emit_vm_status(
                        app,
                        repo_path,
                        Some(&name),
                        Some(provider),
                        "starting",
                        "Cleaning stale VM directory",
                    );
                    if let Err(err) = cleanup_stale_lima_instance(&name) {
                        emit_vm_status(
                            app,
                            repo_path,
                            Some(&name),
                            Some(provider),
                            "error",
                            &format!("Failed to clean stale VM directory: {err}"),
                        );
                        return Err(err);
                    }
                }
            }

            emit_vm_status(
                app,
                repo_path,
                Some(&name),
                Some(provider),
                "creating",
                "Creating new VM",
            );
            limactl_create(&name, repo_path).map_err(|err| {
                emit_vm_status(
                    app,
                    repo_path,
                    Some(&name),
                    Some(provider),
                    "error",
                    &format!("Failed to create VM: {err}"),
                );
                err
            })?;
            emit_vm_status(
                app,
                repo_path,
                Some(&name),
                Some(provider),
                "starting",
                "Starting newly created VM",
            );
            limactl_start(&name, Some(repo_path)).map_err(|err| {
                emit_vm_status(
                    app,
                    repo_path,
                    Some(&name),
                    Some(provider),
                    "error",
                    &format!("Failed to start VM: {err}"),
                );
                err
            })?;
            emit_vm_status(
                app,
                repo_path,
                Some(&name),
                Some(provider),
                "waiting",
                "Waiting for VM to become ready",
            );
            wait_for_vm_ready(provider, &name, 90).map_err(|err| {
                emit_vm_status(
                    app,
                    repo_path,
                    Some(&name),
                    Some(provider),
                    "error",
                    &format!("VM did not become ready: {err}"),
                );
                err
            })?;
            emit_vm_status(
                app,
                repo_path,
                Some(&name),
                Some(provider),
                "bootstrapping",
                "Installing base VM packages",
            );
            ensure_vm_bootstrap(provider, &name).map_err(|err| {
                emit_vm_status(
                    app,
                    repo_path,
                    Some(&name),
                    Some(provider),
                    "error",
                    &format!("VM bootstrap failed: {err}"),
                );
                err
            })?;
            Ok(name)
        }
        VmProvider::Wsl => {
            emit_vm_status(
                app,
                repo_path,
                Some(&name),
                Some(provider),
                "starting",
                &format!("Starting WSL distro {}", name),
            );
            let status = {
                let mut cmd = Command::new("wsl");
                cmd.args(["-d", &name, "--", "true"]);
                apply_shell_env(&mut cmd);
                cmd.status()
            };
            if status.map(|result| result.success()).unwrap_or(false) {
                emit_vm_status(
                    app,
                    repo_path,
                    Some(&name),
                    Some(provider),
                    "waiting",
                    "Waiting for VM to become ready",
                );
                wait_for_vm_ready(provider, &name, 90).map_err(|err| {
                    emit_vm_status(
                        app,
                        repo_path,
                        Some(&name),
                        Some(provider),
                        "error",
                        &format!("VM did not become ready: {err}"),
                    );
                    err
                })?;
                emit_vm_status(
                    app,
                    repo_path,
                    Some(&name),
                    Some(provider),
                    "bootstrapping",
                    "Installing base VM packages",
                );
                ensure_vm_bootstrap(provider, &name).map_err(|err| {
                    emit_vm_status(
                        app,
                        repo_path,
                        Some(&name),
                        Some(provider),
                        "error",
                        &format!("VM bootstrap failed: {err}"),
                    );
                    err
                })?;
                return Ok(name);
            }
            emit_vm_status(
                app,
                repo_path,
                Some(&name),
                Some(provider),
                "creating",
                "Creating new WSL distro",
            );
            let status = {
                let mut cmd = Command::new("wsl");
                cmd.args(["--install", "-d", "Ubuntu", "--name", &name]);
                apply_shell_env(&mut cmd);
                cmd.status()
            }
            .map_err(|e| {
                emit_vm_status(
                    app,
                    repo_path,
                    Some(&name),
                    Some(provider),
                    "error",
                    &format!("Failed to create WSL distribution: {e}"),
                );
                format!("Failed to create WSL distribution: {e}")
            })?;
            if status.success() {
                emit_vm_status(
                    app,
                    repo_path,
                    Some(&name),
                    Some(provider),
                    "waiting",
                    "Waiting for VM to become ready",
                );
                wait_for_vm_ready(provider, &name, 90).map_err(|err| {
                    emit_vm_status(
                        app,
                        repo_path,
                        Some(&name),
                        Some(provider),
                        "error",
                        &format!("VM did not become ready: {err}"),
                    );
                    err
                })?;
                emit_vm_status(
                    app,
                    repo_path,
                    Some(&name),
                    Some(provider),
                    "bootstrapping",
                    "Installing base VM packages",
                );
                ensure_vm_bootstrap(provider, &name).map_err(|err| {
                    emit_vm_status(
                        app,
                        repo_path,
                        Some(&name),
                        Some(provider),
                        "error",
                        &format!("VM bootstrap failed: {err}"),
                    );
                    err
                })?;
                Ok(name)
            } else {
                emit_vm_status(
                    app,
                    repo_path,
                    Some(&name),
                    Some(provider),
                    "error",
                    "WSL failed to create the virtual machine",
                );
                Err("WSL failed to create the virtual machine.".to_string())
            }
        }
    }
}

fn stop_vm_inner(provider: VmProvider, name: &str) -> Result<(), String> {
    let status = match provider {
        VmProvider::Lima => {
            let mut cmd = Command::new("limactl");
            cmd.args(["stop", name]);
            apply_shell_env(&mut cmd);
            cmd.status()
        }
        VmProvider::Wsl => {
            let mut cmd = Command::new("wsl");
            cmd.args(["--terminate", name]);
            apply_shell_env(&mut cmd);
            cmd.status()
        }
    };
    match status {
        Ok(result) if result.success() => Ok(()),
        Ok(_) => Err("Failed to stop virtual machine.".to_string()),
        Err(err) => Err(format!("Failed to stop virtual machine: {err}")),
    }
}

fn stop_vm(provider: VmProvider, name: &str) -> Result<(), String> {
    let _guard = vm_lock()?;
    stop_vm_inner(provider, name)
}

fn delete_vm(provider: VmProvider, name: &str) -> Result<(), String> {
    let _guard = vm_lock()?;
    match provider {
        VmProvider::Lima => {
            let run_delete = |force: bool| -> Result<(), String> {
                let mut cmd = Command::new("limactl");
                if force {
                    cmd.args(["delete", "--force", name]);
                } else {
                    cmd.args(["delete", name]);
                }
                apply_shell_env(&mut cmd);
                let (status, stdout, stderr) =
                    spawn_capture_with_timeout(cmd, Some(VM_START_TIMEOUT_SECS))
                        .map_err(|e| format!("Failed to delete Lima VM: {e}"))?;
                if status.success() {
                    return Ok(());
                }
                let combined =
                    format!("{}\n{}", stdout.trim(), stderr.trim()).trim().to_string();
                if combined.is_empty() {
                    Err("Failed to delete virtual machine.".to_string())
                } else {
                    Err(combined)
                }
            };

            if run_delete(false).is_ok() {
                return Ok(());
            }

            // Fall back to a forced stop + forced delete to handle racey "running" states.
            let mut stop_cmd = Command::new("limactl");
            stop_cmd.args(["stop", "--force", name]);
            apply_shell_env(&mut stop_cmd);
            let _ = stop_cmd.status();
            std::thread::sleep(Duration::from_millis(750));

            run_delete(true)
        }
        VmProvider::Wsl => {
            let mut cmd = Command::new("wsl");
            cmd.args(["--unregister", name]);
            apply_shell_env(&mut cmd);
            let status = cmd.status();
            match status {
                Ok(result) if result.success() => Ok(()),
                Ok(_) => Err("Failed to delete virtual machine.".to_string()),
                Err(err) => Err(format!("Failed to delete virtual machine: {err}")),
            }
        }
    }
}

pub fn vm_app_root(vm: &VmContext, app_root: &Path) -> Result<String, String> {
    if let Ok(rel) = app_root.strip_prefix(&vm.repo_path) {
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        Ok(join_unix(&vm.repo_root, &rel_str))
    } else {
        Ok(vm.repo_root.clone())
    }
}

pub fn vm_env_exports(env_map: &HashMap<String, String>) -> String {
    if env_map.is_empty() {
        return String::new();
    }
    let mut exports = String::new();
    for (key, value) in env_map {
        exports.push_str("export ");
        exports.push_str(key);
        exports.push('=');
        exports.push_str(&shell_escape(value));
        exports.push_str("; ");
    }
    exports
}

pub fn shell_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len() + 2);
    escaped.push('\'');
    for ch in value.chars() {
        if ch == '\'' {
            escaped.push_str("'\"'\"'");
        } else {
            escaped.push(ch);
        }
    }
    escaped.push('\'');
    escaped
}

pub fn build_vm_command(vm: &VmContext, script: &str) -> Command {
    match vm.provider {
        VmProvider::Lima => {
            let mut cmd = Command::new("limactl");
            cmd.args(["shell", "--tty=false", &vm.name, "--", "sh", "-c"]);
            cmd.arg(script);
            apply_shell_env(&mut cmd);
            cmd
        }
        VmProvider::Wsl => {
            let mut cmd = Command::new("wsl");
            cmd.args(["-d", &vm.name, "--", "sh", "-c"]);
            cmd.arg(script);
            apply_shell_env(&mut cmd);
            cmd
        }
    }
}

pub fn spawn_with_timeout(
    mut cmd: Command,
    timeout_secs: Option<u32>,
    silent: bool,
) -> Result<ExitStatus, String> {
    if silent {
        cmd.stdout(Stdio::null()).stderr(Stdio::null());
    } else {
        cmd.stdout(Stdio::inherit()).stderr(Stdio::inherit());
    }

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn command: {e}"))?;

    if let Some(timeout) = timeout_secs {
        let start = Instant::now();
        let timeout_duration = Duration::from_secs(timeout as u64);
        loop {
            if let Some(status) = child
                .try_wait()
                .map_err(|e| format!("Failed to check command: {e}"))?
            {
                return Ok(status);
            }
            if start.elapsed() > timeout_duration {
                let _ = child.kill();
                return Err(format!("Command timed out after {} seconds", timeout));
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    let status = child
        .wait()
        .map_err(|e| format!("Failed to wait for command: {e}"))?;
    Ok(status)
}

pub fn spawn_capture_with_timeout(
    mut cmd: Command,
    timeout_secs: Option<u32>,
) -> Result<(ExitStatus, String, String), String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn command: {e}"))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let stdout_handle = std::thread::spawn(move || -> Vec<u8> {
        let mut buf = Vec::new();
        if let Some(mut out) = stdout {
            let _ = std::io::Read::read_to_end(&mut out, &mut buf);
        }
        buf
    });

    let stderr_handle = std::thread::spawn(move || -> Vec<u8> {
        let mut buf = Vec::new();
        if let Some(mut err) = stderr {
            let _ = std::io::Read::read_to_end(&mut err, &mut buf);
        }
        buf
    });

    let status = if let Some(timeout) = timeout_secs {
        let start = Instant::now();
        let timeout_duration = Duration::from_secs(timeout as u64);
        loop {
            if let Some(status) = child
                .try_wait()
                .map_err(|e| format!("Failed to check command: {e}"))?
            {
                break status;
            }
            if start.elapsed() > timeout_duration {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_handle.join();
                let _ = stderr_handle.join();
                return Err(format!("Command timed out after {} seconds", timeout));
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    } else {
        child
            .wait()
            .map_err(|e| format!("Failed to wait for command: {e}"))?
    };

    let stdout_bytes = stdout_handle.join().unwrap_or_default();
    let stderr_bytes = stderr_handle.join().unwrap_or_default();

    let stdout = String::from_utf8_lossy(&stdout_bytes).to_string();
    let stderr = String::from_utf8_lossy(&stderr_bytes).to_string();

    Ok((status, stdout, stderr))
}

pub fn resolve_backend(app: &AppHandle, repo_path: &Path) -> Result<BackendContext, String> {
    let mode = storage::get_backend_mode(app)?;
    if mode == BackendMode::Host {
        return Ok(BackendContext::host());
    }

    let provider = vm_provider()?;
    let vm_name = ensure_vm_running(provider, repo_path, Some(app))?;
    let repo_root = match resolve_repo_root(provider, &vm_name, repo_path) {
        Ok(value) => value,
        Err(err) => {
            emit_vm_status(
                Some(app),
                repo_path,
                Some(&vm_name),
                Some(provider),
                "error",
                &format!("Repo mount error: {err}"),
            );
            return Err(err);
        }
    };

    Ok(BackendContext {
        mode,
        vm: Some(VmContext {
            provider,
            name: vm_name,
            repo_path: repo_path.to_path_buf(),
            repo_root,
        }),
    })
}

pub fn ensure_backend_for_repo(app: &AppHandle, repo_path: &Path) -> Result<BackendEnsureResult, String> {
    let mode = storage::get_backend_mode(app)?;
    if mode == BackendMode::Host {
        return Ok(BackendEnsureResult {
            mode,
            vm_name: None,
            provider: None,
        });
    }

    let provider = vm_provider()?;
    let vm_name = ensure_vm_running(provider, repo_path, Some(app))?;
    emit_vm_status(
        Some(app),
        repo_path,
        Some(&vm_name),
        Some(provider),
        "checking",
        "Validating repo mount",
    );
    if let Err(err) = resolve_repo_root(provider, &vm_name, repo_path) {
        emit_vm_status(
            Some(app),
            repo_path,
            Some(&vm_name),
            Some(provider),
            "error",
            &format!("Repo mount error: {err}"),
        );
        return Err(err);
    }
    emit_vm_status(
        Some(app),
        repo_path,
        Some(&vm_name),
        Some(provider),
        "ready",
        "VM is ready",
    );
    Ok(BackendEnsureResult {
        mode,
        vm_name: Some(vm_name),
        provider: Some(match provider {
            VmProvider::Lima => "lima".to_string(),
            VmProvider::Wsl => "wsl".to_string(),
        }),
    })
}

pub fn stop_backend_for_repo(app: &AppHandle, repo_path: &Path) -> Result<(), String> {
    let mode = storage::get_backend_mode(app)?;
    if mode == BackendMode::Host {
        return Ok(());
    }
    let provider = vm_provider()?;
    let name = vm_name_for_repo(repo_path);
    emit_vm_status(
        Some(app),
        repo_path,
        Some(&name),
        Some(provider),
        "stopping",
        "Stopping virtual machine",
    );
    match stop_vm(provider, &name) {
        Ok(()) => {
            emit_vm_status(
                Some(app),
                repo_path,
                Some(&name),
                Some(provider),
                "stopped",
                "VM stopped",
            );
            Ok(())
        }
        Err(err) => {
            emit_vm_status(
                Some(app),
                repo_path,
                Some(&name),
                Some(provider),
                "error",
                &format!("Failed to stop VM: {err}"),
            );
            Err(err)
        }
    }
}

pub fn kill_vm_process(handle: &VmProcessHandle, pid: u32) -> Result<(), String> {
    let script = format!("kill {}", pid);
    let vm = VmContext {
        provider: handle.provider,
        name: handle.name.clone(),
        repo_path: PathBuf::new(),
        repo_root: "/".to_string(),
    };
    let mut cmd = build_vm_command(&vm, &script);
    let status = cmd
        .status()
        .map_err(|e| format!("Failed to kill VM process: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("Failed to stop process inside VM.".to_string())
    }
}

#[tauri::command]
pub async fn get_backend_mode(app: AppHandle) -> Result<BackendMode, String> {
    run_blocking(move || storage::get_backend_mode(&app)).await
}

#[tauri::command]
pub async fn set_backend_mode(app: AppHandle, mode: BackendMode) -> Result<(), String> {
    run_blocking(move || storage::set_backend_mode(&app, mode)).await
}

#[tauri::command]
pub async fn check_virtualized_backend_prereq() -> Result<BackendPrereqStatus, String> {
    run_blocking(|| {
        let provider = vm_provider()?;
        let installed = match provider {
            VmProvider::Lima => command_exists("limactl"),
            VmProvider::Wsl => check_wsl_available(),
        };
        let tool = tool_name(provider).to_string();
        let message = if installed {
            None
        } else {
            Some(format!(
                "{} is required to run the virtualized backend.",
                tool
            ))
        };
        Ok(BackendPrereqStatus {
            installed,
            tool,
            message,
        })
    })
    .await
}

#[tauri::command]
pub async fn install_virtualized_backend_prereq() -> Result<String, String> {
    run_blocking(|| {
        let provider = vm_provider()?;
        install_prereq(provider)
    })
    .await
}

#[tauri::command]
pub async fn ensure_repo_backend(app: AppHandle, repo_path: String) -> Result<BackendEnsureResult, String> {
    run_blocking(move || {
        let path = Path::new(&repo_path);
        ensure_backend_for_repo(&app, path)
    })
    .await
}

#[tauri::command]
pub async fn stop_repo_backend(app: AppHandle, repo_path: String) -> Result<(), String> {
    run_blocking(move || {
        let path = Path::new(&repo_path);
        stop_backend_for_repo(&app, path)
    })
    .await
}

#[tauri::command]
pub async fn delete_repo_backend(app: AppHandle, repo_path: String) -> Result<(), String> {
    run_blocking(move || {
        let path = Path::new(&repo_path);
        let mode = storage::get_backend_mode(&app)?;
        if mode == BackendMode::Host {
            return Ok(());
        }
        let provider = vm_provider()?;
        let name = vm_name_for_repo(path);
        emit_vm_status(
            Some(&app),
            path,
            Some(&name),
            Some(provider),
            "deleting",
            "Deleting virtual machine",
        );
        match delete_vm(provider, &name) {
            Ok(()) => {
                emit_vm_status(
                    Some(&app),
                    path,
                    Some(&name),
                    Some(provider),
                    "deleted",
                    "VM deleted",
                );
                Ok(())
            }
            Err(err) => {
                emit_vm_status(
                    Some(&app),
                    path,
                    Some(&name),
                    Some(provider),
                    "error",
                    &format!("Failed to delete VM: {err}"),
                );
                Err(err)
            }
        }
    })
    .await
}

pub fn background_launch_script(command: &str) -> String {
    let escaped = shell_escape(command);
    format!("nohup sh -c {} > /dev/null 2>&1 & echo $!", escaped)
}

pub fn extract_pid(output: &str) -> Result<u32, String> {
    let pid = output
        .lines()
        .rev()
        .find_map(|line| line.trim().parse::<u32>().ok())
        .ok_or_else(|| "Failed to determine VM process id.".to_string())?;
    Ok(pid)
}
