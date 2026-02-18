use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};
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
const CONTAINER_BUILD_TIMEOUT_SECS: u32 = 600;
const DOCKERFILE_IMAGE_VERSION: u8 = 1;

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
    pub vm_repo_root: String,
    pub container_name: Option<String>,
    pub vm_uid: Option<u32>,
    pub vm_gid: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct VmProcessHandle {
    pub provider: VmProvider,
    pub name: String,
    pub container_name: Option<String>,
    pub vm_uid: Option<u32>,
    pub vm_gid: Option<u32>,
}

#[derive(Debug, Clone)]
pub enum BackendProcess {
    Host { pid: u32 },
    Virtualized { pid: u32, vm: VmProcessHandle },
    VirtualizedContainer { name: String, vm: VmProcessHandle },
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

#[derive(Debug, Serialize, Clone)]
pub struct BackendVmInfo {
    pub name: String,
    pub provider: String,
    pub status: String,
    pub repo_path: Option<String>,
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
    if provider == VmProvider::Lima {
        return Ok(());
    }
    let vm = VmContext {
        provider,
        name: name.to_string(),
        repo_path: PathBuf::new(),
        repo_root: "/".to_string(),
        vm_repo_root: "/".to_string(),
        container_name: None,
        vm_uid: None,
        vm_gid: None,
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

fn dockerfile_hash(repo_path: &Path, app_id: &str) -> String {
    let key = format!("{}:{}", repo_path.to_string_lossy(), app_id);
    let hash = fnv1a_hash(&key);
    format!("{:08x}", (hash & 0xffff_ffff) as u32)
}

fn docker_container_name_for_app(repo_path: &Path, app_id: &str) -> String {
    let base = repo_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("repo");
    let suffix = dockerfile_hash(repo_path, app_id);
    format!(
        "falck-{}-{}-{}",
        sanitize_name(base),
        sanitize_name(app_id),
        suffix
    )
}

fn docker_image_name_for_app(repo_path: &Path, app_id: &str) -> String {
    let base = repo_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("repo");
    let suffix = dockerfile_hash(repo_path, app_id);
    format!(
        "falck-app-{}-{}-{}-v{}",
        sanitize_name(base),
        sanitize_name(app_id),
        suffix,
        DOCKERFILE_IMAGE_VERSION
    )
}

fn nerdctl_exists(vm: &VmContext) -> bool {
    let script = "command -v nerdctl >/dev/null 2>&1";
    let cmd = build_vm_command(vm, script);
    spawn_with_timeout(cmd, Some(VM_SHELL_TIMEOUT_SECS), true)
        .map(|status| status.success())
        .unwrap_or(false)
}

fn ensure_vm_sudo(vm: &VmContext) -> Result<(), String> {
    let check = build_vm_command(vm, "command -v sudo >/dev/null 2>&1");
    if !spawn_with_timeout(check, Some(VM_SHELL_TIMEOUT_SECS), true)
        .map(|status| status.success())
        .unwrap_or(false)
    {
        return Err("sudo is required inside the VM to run containers.".to_string());
    }
    let cmd = build_vm_command(vm, "sudo -n true");
    let status = spawn_with_timeout(cmd, Some(VM_SHELL_TIMEOUT_SECS), true)
        .map_err(|e| format!("Failed to check sudo: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "sudo requires a password. Run: limactl shell {} -- sudo -v",
            vm.name
        ))
    }
}

fn vm_user_ids(vm: &VmContext) -> Result<(u32, u32), String> {
    let script = "printf '%s:%s' \"$(id -u)\" \"$(id -g)\"";
    let cmd = build_vm_command(vm, script);
    let (status, stdout, stderr) =
        spawn_capture_with_timeout(cmd, Some(VM_SHELL_TIMEOUT_SECS))
            .map_err(|e| format!("Failed to read VM user ids: {e}"))?;
    if !status.success() {
        let combined = format!("{}\n{}", stdout.trim(), stderr.trim()).trim().to_string();
        if combined.is_empty() {
            return Err("Failed to read VM user ids.".to_string());
        }
        return Err(combined);
    }
    let raw = stdout.trim();
    let mut parts = raw.split(':');
    let uid = parts
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .ok_or_else(|| "Failed to parse VM uid.".to_string())?;
    let gid = parts
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .ok_or_else(|| "Failed to parse VM gid.".to_string())?;
    Ok((uid, gid))
}

pub fn container_user_spec(vm: &VmContext) -> Option<String> {
    match (vm.vm_uid, vm.vm_gid) {
        (Some(uid), Some(gid)) => Some(format!("{}:{}", uid, gid)),
        _ => None,
    }
}

fn build_nerdctl_command(vm: &VmContext) -> Command {
    let mut cmd = Command::new("limactl");
    cmd.args([
        "shell",
        "--tty=false",
        &vm.name,
        "--",
        "sudo",
        "-n",
        "nerdctl",
    ]);
    apply_shell_env(&mut cmd);
    cmd
}

pub fn build_container_exec_command(
    vm: &VmContext,
    container_name: &str,
    user: Option<&str>,
    script: &str,
) -> Command {
    let mut cmd = build_nerdctl_command(vm);
    cmd.arg("exec");
    if let Some(user) = user {
        cmd.args(["--user", user]);
    }
    cmd.arg(container_name);
    cmd.args(["sh", "-c", script]);
    cmd
}

fn container_names(vm: &VmContext, all: bool) -> Result<HashSet<String>, String> {
    let mut cmd = build_nerdctl_command(vm);
    if all {
        cmd.args(["ps", "-a", "--format", "{{.Names}}"]);
    } else {
        cmd.args(["ps", "--format", "{{.Names}}"]);
    }
    let (status, stdout, stderr) =
        spawn_capture_with_timeout(cmd, Some(VM_SHELL_TIMEOUT_SECS))
            .map_err(|e| format!("Failed to list containers: {e}"))?;
    if !status.success() {
        let combined = format!("{}\n{}", stdout.trim(), stderr.trim()).trim().to_string();
        if combined.is_empty() {
            return Err("Failed to list containers.".to_string());
        }
        return Err(combined);
    }
    Ok(stdout
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .map(|line| line.to_string())
        .collect())
}

fn container_exists(vm: &VmContext, name: &str) -> Result<bool, String> {
    Ok(container_names(vm, true)?.contains(name))
}

fn remove_container(vm: &VmContext, name: &str) -> Result<(), String> {
    let mut cmd = build_nerdctl_command(vm);
    cmd.args(["rm", "-f", name]);
    let status = spawn_with_timeout(cmd, Some(VM_SHELL_TIMEOUT_SECS), true)
        .map_err(|e| format!("Failed to remove container: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("Failed to remove container.".to_string())
    }
}

pub fn run_dockerfile_container(
    app: Option<&AppHandle>,
    vm: &VmContext,
    app_id: &str,
    dockerfile_path: &str,
    context_path: &str,
    env_map: &HashMap<String, String>,
) -> Result<String, String> {
    if vm.provider != VmProvider::Lima {
        return Err("Dockerfile launches are only supported on Lima.".to_string());
    }
    if dockerfile_path.trim().is_empty() {
        return Err("Dockerfile path is empty.".to_string());
    }
    if context_path.trim().is_empty() {
        return Err("Docker build context is empty.".to_string());
    }
    ensure_vm_sudo(vm)?;
    if !nerdctl_exists(vm) {
        return Err(format!(
            "nerdctl is not available in this Lima VM. Use Settings > Reset VM (or `limactl delete {}`) and try again.",
            vm.name
        ));
    }

    let image = docker_image_name_for_app(&vm.repo_path, app_id);
    let container_name = docker_container_name_for_app(&vm.repo_path, app_id);

    if container_exists(vm, &container_name)? {
        emit_vm_status(
            app,
            &vm.repo_path,
            Some(&vm.name),
            Some(vm.provider),
            "deleting",
            "Removing existing container",
        );
        remove_container(vm, &container_name)?;
    }

    emit_vm_status(
        app,
        &vm.repo_path,
        Some(&vm.name),
        Some(vm.provider),
        "bootstrapping",
        "Building Docker image",
    );
    let mut build_cmd = build_nerdctl_command(vm);
    build_cmd.args(["build", "-t", &image, "-f", dockerfile_path, context_path]);
    let (build_status, build_stdout, build_stderr) =
        spawn_capture_with_timeout(build_cmd, Some(CONTAINER_BUILD_TIMEOUT_SECS))
            .map_err(|e| format!("Failed to build Docker image: {e}"))?;
    if !build_status.success() {
        let combined = format!("{}\n{}", build_stdout.trim(), build_stderr.trim())
            .trim()
            .to_string();
        let message = if combined.is_empty() {
            "Docker build failed.".to_string()
        } else {
            combined
        };
        emit_vm_status(
            app,
            &vm.repo_path,
            Some(&vm.name),
            Some(vm.provider),
            "error",
            &format!("Docker build failed: {}", message),
        );
        return Err(message);
    }

    emit_vm_status(
        app,
        &vm.repo_path,
        Some(&vm.name),
        Some(vm.provider),
        "starting",
        "Starting Docker container",
    );
    let mut run_cmd = build_nerdctl_command(vm);
    run_cmd.args(["run", "-d", "--name", &container_name, "--net=host"]);
    for (key, value) in env_map {
        run_cmd.args(["--env", &format!("{}={}", key, value)]);
    }
    run_cmd.arg(&image);
    let (run_status, run_stdout, run_stderr) =
        spawn_capture_with_timeout(run_cmd, Some(VM_START_TIMEOUT_SECS))
            .map_err(|e| format!("Failed to start Docker container: {e}"))?;
    if !run_status.success() {
        let combined = format!("{}\n{}", run_stdout.trim(), run_stderr.trim())
            .trim()
            .to_string();
        let message = if combined.is_empty() {
            "Failed to start Docker container.".to_string()
        } else {
            combined
        };
        emit_vm_status(
            app,
            &vm.repo_path,
            Some(&vm.name),
            Some(vm.provider),
            "error",
            &format!("Docker run failed: {}", message),
        );
        return Err(message);
    }

    emit_vm_status(
        app,
        &vm.repo_path,
        Some(&vm.name),
        Some(vm.provider),
        "ready",
        "Docker container is running",
    );
    Ok(container_name)
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

fn lima_containerd_yq() -> &'static str {
    ".containerd.system = true | .containerd.user = false"
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
        ".mountInotify = true | .mounts = [{{\"location\": {home}}}, {{\"location\": {repo}, \"mountPoint\": {mount}, \"writable\": true}}]",
        home = home_location,
        repo = repo_location,
        mount = repo_mount
    )
}

fn normalize_ports(ports: &[u16]) -> Vec<u16> {
    let mut set = BTreeSet::new();
    for port in ports {
        if *port > 0 {
            set.insert(*port);
        }
    }
    set.into_iter().collect()
}

fn lima_port_forwards_yq(ports: &[u16]) -> Option<String> {
    let ports = normalize_ports(ports);
    if ports.is_empty() {
        return None;
    }
    let entries = ports
        .iter()
        .map(|port| format!("{{\"guestPort\": {port}, \"hostPort\": {port}}}"))
        .collect::<Vec<_>>()
        .join(", ");
    Some(format!(
        ".portForwards = (.portForwards // []) + [{}]",
        entries
    ))
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
    status: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LimaConfig {
    mounts: Option<Vec<LimaMount>>,
    #[serde(rename = "portForwards")]
    port_forwards: Option<Vec<LimaPortForward>>,
}

#[derive(Debug, Deserialize)]
struct LimaMount {
    location: Option<String>,
    #[serde(rename = "mountPoint")]
    mount_point: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
struct LimaPortForward {
    #[serde(rename = "guestPort")]
    guest_port: Option<u16>,
}

fn entries_from_array(items: Vec<serde_json::Value>) -> Result<Vec<LimaListEntry>, String> {
    let mut entries = Vec::new();
    for entry in items {
        let parsed: LimaListEntry = serde_json::from_value(entry)
            .map_err(|e| format!("Failed to parse Lima VM list entry: {e}"))?;
        entries.push(parsed);
    }
    Ok(entries)
}

fn entries_from_value(value: serde_json::Value) -> Result<Option<Vec<LimaListEntry>>, String> {
    match value {
        serde_json::Value::Array(items) => Ok(Some(entries_from_array(items)?)),
        serde_json::Value::Object(obj) => {
            if let Some(entries) = obj.get("entries") {
                if let serde_json::Value::Array(items) = entries {
                    return Ok(Some(entries_from_array(items.clone())?));
                }
            }
            if obj.contains_key("name") {
                let parsed: LimaListEntry = serde_json::from_value(serde_json::Value::Object(obj))
                    .map_err(|e| format!("Failed to parse Lima VM list entry: {e}"))?;
                return Ok(Some(vec![parsed]));
            }
            Ok(None)
        }
        _ => Ok(None),
    }
}

fn parse_lima_list_entries(raw: &[u8]) -> Result<Vec<LimaListEntry>, String> {
    let mut slices = vec![raw];
    if let Some(start) = raw.iter().position(|b| *b == b'{' || *b == b'[') {
        slices.push(&raw[start..]);
    }

    let mut last_error = None;
    let mut entries = Vec::new();
    for slice in slices {
        let mut stream = serde_json::Deserializer::from_slice(slice).into_iter::<serde_json::Value>();
        while let Some(result) = stream.next() {
            match result {
                Ok(value) => match entries_from_value(value) {
                    Ok(Some(mut next)) => {
                        entries.append(&mut next);
                    }
                    Ok(None) => {}
                    Err(err) => {
                        last_error = Some(err);
                    }
                },
                Err(err) => {
                    last_error = Some(format!("Failed to parse Lima VM list: {err}"));
                    break;
                }
            }
        }
        if !entries.is_empty() {
            return Ok(entries);
        }
    }
    Err(last_error.unwrap_or_else(|| {
        "Failed to parse Lima VM list: unexpected JSON format.".to_string()
    }))
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
    parse_lima_list_entries(&output.stdout)
        .map(|items| items.iter().any(|item| item.name == name))
        .unwrap_or(false)
}

fn wsl_instance_registered(name: &str) -> bool {
    if !command_exists("wsl") {
        return false;
    }
    let output = Command::new("wsl").args(["-l", "-q"]).output();
    let Ok(output) = output else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout.lines().any(|line| line.trim() == name)
}

fn lima_config_path(name: &str) -> Option<PathBuf> {
    let dir = lima_instance_dir(name)?;
    let candidates = ["lima.yaml", "config.yaml"];
    for file in candidates {
        let path = dir.join(file);
        if path.exists() {
            return Some(path);
        }
    }
    None
}

fn read_lima_config(name: &str) -> Option<LimaConfig> {
    let path = lima_config_path(name)?;
    let contents = fs::read_to_string(path).ok()?;
    serde_yaml::from_str::<LimaConfig>(&contents).ok()
}

fn lima_repo_path_from_config(name: &str) -> Option<String> {
    let config = read_lima_config(name)?;
    let mounts = config.mounts?;
    for mount in mounts {
        let mount_point = mount.mount_point.unwrap_or_default();
        if mount_point.starts_with("/mnt/falck") {
            let location = mount.location?;
            if !location.trim().is_empty() {
                return Some(location);
            }
        }
    }
    None
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

fn normalize_vm_status(value: Option<&str>) -> String {
    let raw = value.unwrap_or("").trim().to_lowercase();
    if raw.contains("running") {
        "running".to_string()
    } else if raw.contains("stopped") || raw.contains("stop") || raw.contains("terminated") {
        "stopped".to_string()
    } else if raw.contains("starting") || raw.contains("boot") {
        "starting".to_string()
    } else {
        "unknown".to_string()
    }
}

fn build_repo_vm_map(app: &AppHandle) -> Result<HashMap<String, String>, String> {
    let repos = storage::list_repos(app)?;
    let mut map = HashMap::new();
    for repo in repos {
        let name = vm_name_for_repo(Path::new(&repo.path));
        map.insert(name, repo.path);
    }
    Ok(map)
}

fn list_lima_vms(app: &AppHandle) -> Result<Vec<BackendVmInfo>, String> {
    if !command_exists("limactl") {
        return Err("Lima is not installed.".to_string());
    }
    let output = {
        let mut cmd = Command::new("limactl");
        cmd.args(["list", "--json", "--tty=false"]);
        apply_shell_env(&mut cmd);
        cmd.output()
    }
    .map_err(|e| format!("Failed to list Lima VMs: {e}"))?;
    if !output.status.success() {
        return Err("Failed to list Lima VMs.".to_string());
    }
    let entries = parse_lima_list_entries(&output.stdout)?;
    let repo_map = build_repo_vm_map(app)?;
    let mut vms = Vec::new();
    for entry in entries {
        let repo_path = repo_map
            .get(&entry.name)
            .cloned()
            .or_else(|| lima_repo_path_from_config(&entry.name));
        vms.push(BackendVmInfo {
            name: entry.name,
            provider: "lima".to_string(),
            status: normalize_vm_status(entry.status.as_deref()),
            repo_path,
        });
    }
    Ok(vms)
}

fn parse_wsl_list(output: &str) -> Vec<(String, String)> {
    let mut vms = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let lower = trimmed.to_lowercase();
        if lower.starts_with("name") && lower.contains("state") {
            continue;
        }
        let trimmed = trimmed.trim_start_matches('*').trim();
        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        if parts.len() < 2 {
            continue;
        }
        let state = parts[parts.len().saturating_sub(2)];
        let name = parts[..parts.len().saturating_sub(2)].join(" ");
        if name.is_empty() {
            continue;
        }
        vms.push((name, state.to_string()));
    }
    vms
}

fn list_wsl_vms(app: &AppHandle) -> Result<Vec<BackendVmInfo>, String> {
    if !command_exists("wsl") {
        return Err("WSL is not installed.".to_string());
    }
    let output = {
        let mut cmd = Command::new("wsl");
        cmd.args(["-l", "-v"]);
        apply_shell_env(&mut cmd);
        cmd.output()
    }
    .map_err(|e| format!("Failed to list WSL distributions: {e}"))?;
    if !output.status.success() {
        return Err("Failed to list WSL distributions.".to_string());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let repo_map = build_repo_vm_map(app)?;
    let mut vms = Vec::new();
    for (name, state) in parse_wsl_list(&stdout) {
        let repo_path = repo_map.get(&name).cloned();
        vms.push(BackendVmInfo {
            name,
            provider: "wsl".to_string(),
            status: normalize_vm_status(Some(&state)),
            repo_path,
        });
    }
    Ok(vms)
}

fn lima_forwarded_ports(name: &str) -> HashSet<u16> {
    let mut ports = HashSet::new();
    let Some(config) = read_lima_config(name) else {
        return ports;
    };
    let Some(entries) = config.port_forwards else {
        return ports;
    };
    for entry in entries {
        if let Some(guest) = entry.guest_port {
            ports.insert(guest);
        }
    }
    ports
}

pub fn ensure_vm_port_forwards(
    app: Option<&AppHandle>,
    vm: &VmContext,
    ports: &[u16],
) -> Result<(), String> {
    if vm.provider != VmProvider::Lima {
        return Ok(());
    }
    let desired = normalize_ports(ports);
    if desired.is_empty() {
        return Ok(());
    }

    let existing = lima_forwarded_ports(&vm.name);
    let missing: Vec<u16> = desired
        .into_iter()
        .filter(|port| !existing.contains(port))
        .collect();

    if missing.is_empty() {
        return Ok(());
    }

    emit_vm_status(
        app,
        &vm.repo_path,
        Some(&vm.name),
        Some(vm.provider),
        "stopping",
        "Restarting VM to apply port forwards",
    );

    let _guard = vm_lock()?;
    let _ = stop_vm_inner(vm.provider, &vm.name);

    emit_vm_status(
        app,
        &vm.repo_path,
        Some(&vm.name),
        Some(vm.provider),
        "starting",
        "Applying port forwards",
    );
    limactl_start(&vm.name, Some(&vm.repo_path), Some(&missing)).map_err(|err| {
        emit_vm_status(
            app,
            &vm.repo_path,
            Some(&vm.name),
            Some(vm.provider),
            "error",
            &format!("Failed to start VM with port forwards: {err}"),
        );
        err
    })?;
    emit_vm_status(
        app,
        &vm.repo_path,
        Some(&vm.name),
        Some(vm.provider),
        "waiting",
        "Waiting for VM to become ready",
    );
    wait_for_vm_ready(vm.provider, &vm.name, 90).map_err(|err| {
        emit_vm_status(
            app,
            &vm.repo_path,
            Some(&vm.name),
            Some(vm.provider),
            "error",
            &format!("VM did not become ready: {err}"),
        );
        err
    })?;
    if vm.provider != VmProvider::Lima {
        emit_vm_status(
            app,
            &vm.repo_path,
            Some(&vm.name),
            Some(vm.provider),
            "bootstrapping",
            "Ensuring base dependencies are installed",
        );
        ensure_vm_bootstrap(vm.provider, &vm.name).map_err(|err| {
            emit_vm_status(
                app,
                &vm.repo_path,
                Some(&vm.name),
                Some(vm.provider),
                "error",
                &format!("VM bootstrap failed: {err}"),
            );
            err
        })?;
    }
    emit_vm_status(
        app,
        &vm.repo_path,
        Some(&vm.name),
        Some(vm.provider),
        "ready",
        "VM is ready",
    );
    Ok(())
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
        vm_repo_root: "/".to_string(),
        container_name: None,
        vm_uid: None,
        vm_gid: None,
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
        vm_repo_root: "/".to_string(),
        container_name: None,
        vm_uid: None,
        vm_gid: None,
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

fn limactl_start(
    name: &str,
    repo_path: Option<&Path>,
    port_forwards: Option<&[u16]>,
) -> Result<(), String> {
    let cmd = {
        let mut cmd = Command::new("limactl");
        cmd.args(["start", "--tty=false"]);
        cmd.args(["--set", lima_containerd_yq()]);
        if let Some(repo_path) = repo_path {
            let mounts_expr = lima_mounts_yq(repo_path);
            cmd.args(["--set", &mounts_expr]);
        }
        if let Some(port_forwards) = port_forwards {
            if let Some(expr) = lima_port_forwards_yq(port_forwards) {
                cmd.args(["--set", &expr]);
            }
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

fn limactl_create(
    name: &str,
    repo_path: &Path,
    port_forwards: Option<&[u16]>,
) -> Result<(), String> {
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
        ]);
        cmd.args(["--set", lima_containerd_yq()]);
        cmd.arg("template://2.0/containerd");
        if let Some(port_forwards) = port_forwards {
            if let Some(expr) = lima_port_forwards_yq(port_forwards) {
                cmd.args(["--set", &expr]);
            }
        }
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
        if let Some(app) = app {
            let name = vm_name_for_repo(repo_path);
            emit_vm_status(
                Some(app),
                repo_path,
                Some(&name),
                Some(provider),
                "waiting",
                "Waiting for VM startup",
            );
        }
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
            if limactl_start(&name, Some(repo_path), None).is_ok() {
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
                if let Err(err) = limactl_start(&name, Some(repo_path), None) {
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
            limactl_create(&name, repo_path, None).map_err(|err| {
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
            limactl_start(&name, Some(repo_path), None).map_err(|err| {
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
                    "Ensuring base dependencies are installed",
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
                "Ensuring base dependencies are installed",
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
    let vm_repo_root = match resolve_repo_root(provider, &vm_name, repo_path) {
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
            repo_root: vm_repo_root.clone(),
            vm_repo_root,
            container_name: None,
            vm_uid: None,
            vm_gid: None,
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
    let vm_repo_root = match resolve_repo_root(provider, &vm_name, repo_path) {
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
    let exists = match provider {
        VmProvider::Lima => lima_instance_registered(&name),
        VmProvider::Wsl => wsl_instance_registered(&name),
    };
    if !exists {
        return Ok(());
    }
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

fn list_backend_vms_inner(app: &AppHandle) -> Result<Vec<BackendVmInfo>, String> {
    let provider = vm_provider()?;
    match provider {
        VmProvider::Lima => list_lima_vms(app),
        VmProvider::Wsl => list_wsl_vms(app),
    }
}

#[tauri::command]
pub async fn list_backend_vms(app: AppHandle) -> Result<Vec<BackendVmInfo>, String> {
    run_blocking(move || list_backend_vms_inner(&app)).await
}

#[tauri::command]
pub async fn stop_backend_vm(name: String) -> Result<(), String> {
    run_blocking(move || {
        let provider = vm_provider()?;
        stop_vm(provider, &name)
    })
    .await
}

#[tauri::command]
pub async fn delete_backend_vm(name: String) -> Result<(), String> {
    run_blocking(move || {
        let provider = vm_provider()?;
        delete_vm(provider, &name)
    })
    .await
}

pub fn kill_vm_process(handle: &VmProcessHandle, pid: u32) -> Result<(), String> {
    let script = format!("kill {}", pid);
    let vm = VmContext {
        provider: handle.provider,
        name: handle.name.clone(),
        repo_path: PathBuf::new(),
        repo_root: "/".to_string(),
        vm_repo_root: "/".to_string(),
        container_name: handle.container_name.clone(),
        vm_uid: handle.vm_uid,
        vm_gid: handle.vm_gid,
    };
    let status = if let Some(container_name) = handle.container_name.as_deref() {
        let user = container_user_spec(&vm);
        let mut cmd = build_container_exec_command(&vm, container_name, user.as_deref(), &script);
        cmd.status()
            .map_err(|e| format!("Failed to kill container process: {e}"))?
    } else {
        let mut cmd = build_vm_command(&vm, &script);
        cmd.status()
            .map_err(|e| format!("Failed to kill VM process: {e}"))?
    };
    if status.success() {
        Ok(())
    } else if handle.container_name.is_some() {
        Err("Failed to stop process inside container.".to_string())
    } else {
        Err("Failed to stop process inside VM.".to_string())
    }
}

pub fn stop_vm_container(handle: &VmProcessHandle, container_name: &str) -> Result<(), String> {
    if handle.provider != VmProvider::Lima {
        return Err("Docker containers are only supported on Lima.".to_string());
    }
    if container_name.trim().is_empty() {
        return Err("Container name is empty.".to_string());
    }
    let mut cmd = Command::new("limactl");
    cmd.args([
        "shell",
        "--tty=false",
        &handle.name,
        "--",
        "sudo",
        "-n",
        "nerdctl",
        "rm",
        "-f",
        container_name,
    ]);
    apply_shell_env(&mut cmd);
    let status = spawn_with_timeout(cmd, Some(VM_SHELL_TIMEOUT_SECS), true)
        .map_err(|e| format!("Failed to stop container: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("Failed to stop container.".to_string())
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
    eprintln!(
        "[falck][backend] ensure_repo_backend request for {}",
        repo_path
    );
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
