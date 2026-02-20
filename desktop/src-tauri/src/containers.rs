use anyhow::{bail, Context, Result as AnyhowResult};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

use crate::blocking::run_blocking;
use crate::storage::{self, StoredContainer};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LimaStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub source: Option<LimaSource>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum LimaSource {
    System,
    Bundled,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ContainerInfo {
    pub id: String,
    pub repo_path: String,
    pub app_id: Option<String>,
    pub name: String,
    pub vm: String,
    pub image: Option<String>,
    pub status: Option<String>,
    pub state: String,
    pub last_used: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ContainerHandle {
    pub id: String,
    pub repo_path: String,
    pub name: String,
    pub vm: String,
}

#[derive(Debug, Clone)]
pub enum ContainerMountSource {
    Bind(PathBuf),
    Volume(String),
}

#[derive(Debug, Clone)]
pub struct ContainerMountSpec {
    pub source: ContainerMountSource,
    pub target: String,
    pub mode: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ContainerLaunchSpec {
    pub repo_path: PathBuf,
    pub app_id: Option<String>,
    pub vm: String,
    pub name: String,
    pub image: String,
    pub dockerfile_path: PathBuf,
    pub context_dir: PathBuf,
    pub ports: Vec<String>,
    pub mounts: Vec<ContainerMountSpec>,
    pub env: HashMap<String, String>,
    pub workdir: String,
}

#[derive(Debug, Clone, Serialize)]
struct ContainerStatusEvent {
    status: String,
    message: String,
    repo_path: Option<String>,
    app_id: Option<String>,
    vm: Option<String>,
    container: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct ContainerLogEvent {
    log: String,
    repo_path: Option<String>,
    app_id: Option<String>,
    vm: Option<String>,
    container: Option<String>,
}

#[derive(Debug, Clone)]
struct EventContext {
    repo_path: Option<String>,
    app_id: Option<String>,
    vm: Option<String>,
    container: Option<String>,
}

fn now_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .unwrap_or(0)
}

fn container_id(repo_path: &str, vm: &str, name: &str) -> String {
    format!("{}::{}::{}", repo_path, vm, name)
}

fn emit_container_status(app: &AppHandle, status: &str, message: &str, ctx: &EventContext) {
    let _ = app.emit(
        "container-status",
        ContainerStatusEvent {
            status: status.to_string(),
            message: message.to_string(),
            repo_path: ctx.repo_path.clone(),
            app_id: ctx.app_id.clone(),
            vm: ctx.vm.clone(),
            container: ctx.container.clone(),
        },
    );
}

fn emit_container_log(app: &AppHandle, log: &str, ctx: &EventContext) {
    let _ = app.emit(
        "container-log",
        ContainerLogEvent {
            log: log.to_string(),
            repo_path: ctx.repo_path.clone(),
            app_id: ctx.app_id.clone(),
            vm: ctx.vm.clone(),
            container: ctx.container.clone(),
        },
    );
}

fn limactl_executable_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "limactl.exe"
    } else {
        "limactl"
    }
}

const BUNDLED_LIMA_VERSION: &str = "2.0.3";
const FALCK_LIMA_TEMPLATE: &str = r#"
images:
  - location: "https://cloud-images.ubuntu.com/releases/24.04/release/ubuntu-24.04-server-cloudimg-amd64.img"
    arch: "x86_64"
  - location: "https://cloud-images.ubuntu.com/releases/24.04/release/ubuntu-24.04-server-cloudimg-arm64.img"
    arch: "aarch64"
mounts:
  - location: "~"
"#;

#[derive(Debug, Clone)]
struct LimactlLocation {
    path: PathBuf,
    source: LimaSource,
}

fn find_in_path(command: &str) -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let output = Command::new("where").arg(command).output();

    #[cfg(not(target_os = "windows"))]
    let output = Command::new("which").arg(command).output();

    let output = output.ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .next()
        .map(|line| PathBuf::from(line.trim()))
        .filter(|path| !path.as_os_str().is_empty())
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

    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
            if name.starts_with(prefix) {
                return Some(path);
            }
        }
    }

    None
}

fn limactl_share_dir(path: &Path) -> Option<PathBuf> {
    let parent = path.parent()?;
    let prefix = parent.parent()?;
    Some(prefix.join("share").join("lima"))
}

fn limactl_has_guest_agents(path: &Path) -> bool {
    let Some(share_dir) = limactl_share_dir(path) else {
        return false;
    };
    guest_agent_filenames()
        .iter()
        .any(|name| share_dir.join(name).exists())
}

fn find_bundled_limactl(app: &AppHandle) -> Option<PathBuf> {
    let mut fallback: Option<PathBuf> = None;

    if let Ok(resource_dir) = app.path().resource_dir() {
        for candidate in [
            resource_dir.clone(),
            resource_dir.join("sidecars"),
            resource_dir.join("binaries"),
        ] {
            if let Some(found) = find_named_in_dir(&candidate, "limactl") {
                if limactl_has_guest_agents(&found) {
                    return Some(found);
                }
                if fallback.is_none() {
                    fallback = Some(found);
                }
            }
        }
    }

    if let Ok(current) = tauri::process::current_binary(&app.env()) {
        if let Some(parent) = current.parent() {
            for candidate in [parent.to_path_buf(), parent.join("sidecars")] {
                if let Some(found) = find_named_in_dir(&candidate, "limactl") {
                    if limactl_has_guest_agents(&found) {
                        return Some(found);
                    }
                    if fallback.is_none() {
                        fallback = Some(found);
                    }
                }
            }
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
        if let Some(found) = find_named_in_dir(&candidate, "limactl") {
            if limactl_has_guest_agents(&found) {
                return Some(found);
            }
            if fallback.is_none() {
                fallback = Some(found);
            }
        }
    }

    fallback
}

fn falck_lima_home(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(value) = std::env::var("FALCK_LIMA_HOME") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }

    let home_dir = app.path().home_dir().map_err(|e| e.to_string())?;
    Ok(home_dir.join(".falck").join("lima"))
}

fn find_lima_template_source(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidate = resource_dir.join("lima").join("templates").join("default.yaml");
        if candidate.exists() {
            return Some(candidate);
        }
    }

    let cwd = std::env::current_dir().ok();
    let candidates = [
        cwd.as_ref()
            .map(|dir| dir.join("resources").join("lima").join("templates").join("default.yaml")),
        cwd.as_ref().map(|dir| {
            dir.join("src-tauri")
                .join("resources")
                .join("lima")
                .join("templates")
                .join("default.yaml")
        }),
        cwd.as_ref().map(|dir| {
            dir.join("..")
                .join("src-tauri")
                .join("resources")
                .join("lima")
                .join("templates")
                .join("default.yaml")
        }),
    ];

    for candidate in candidates.into_iter().flatten() {
        if candidate.exists() {
            return Some(candidate);
        }
    }

    None
}

pub(crate) fn prepare_lima_environment(app: &AppHandle) -> Result<PathBuf, String> {
    let lima_home = falck_lima_home(app)?;
    let templates_dir = lima_home.join("_templates");
    let template_path = templates_dir.join("falck-default.yaml");

    if !template_path.exists() {
        fs::create_dir_all(&templates_dir).map_err(|e| e.to_string())?;
        if let Some(source) = find_lima_template_source(app) {
            fs::copy(&source, &template_path).map_err(|e| e.to_string())?;
        } else {
            fs::write(&template_path, FALCK_LIMA_TEMPLATE).map_err(|e| e.to_string())?;
        }
    }

    std::env::set_var("LIMA_HOME", &lima_home);
    Ok(template_path)
}

fn guest_agent_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" | "arm64" => "aarch64",
        "x86_64" | "amd64" => "x86_64",
        other => other,
    }
}

fn guest_agent_filenames() -> Vec<String> {
    let arch = guest_agent_arch();
    let base = format!("lima-guestagent.Linux-{}", arch);
    let mut names = vec![base.clone(), format!("{}.gz", base)];
    if arch == "aarch64" {
        names.push("lima-guestagent.Linux-arm64".to_string());
        names.push("lima-guestagent.Linux-arm64.gz".to_string());
    }
    names
}

fn limactl_share_dirs(app: &AppHandle, limactl: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(parent) = limactl.parent() {
        if let Some(grand) = parent.parent() {
            dirs.push(grand.join("share").join("lima"));
        }
        dirs.push(parent.join("share").join("lima"));
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        dirs.push(resource_dir.join("share").join("lima"));
    }

    let mut seen = HashSet::new();
    dirs.retain(|dir| seen.insert(dir.clone()));
    dirs
}

fn ensure_lima_guest_agents(app: &AppHandle, limactl: &Path) -> AnyhowResult<()> {
    let filenames = guest_agent_filenames();
    let dirs = limactl_share_dirs(app, limactl);
    let found = dirs.iter().any(|dir| {
        filenames
            .iter()
            .any(|name| dir.join(name).exists())
    });

    if found {
        return Ok(());
    }

    let missing = filenames.join(" or ");
    bail!(
        "Falck is missing a required VM helper file. Please reinstall Falck. (Missing: {})",
        missing
    )
}

fn find_limactl_location(app: &AppHandle) -> Option<LimactlLocation> {
    if let Some(path) = find_in_path(limactl_executable_name()) {
        return Some(LimactlLocation {
            path,
            source: LimaSource::System,
        });
    }

    if let Some(path) = find_bundled_limactl(app) {
        return Some(LimactlLocation {
            path,
            source: LimaSource::Bundled,
        });
    }

    None
}

pub(crate) fn limactl_path(app: &AppHandle) -> Option<PathBuf> {
    let location = find_limactl_location(app)?;
    if prepare_lima_environment(app).is_err() {
        return None;
    }
    Some(location.path)
}

fn limactl_version(path: &Path) -> Option<String> {
    let output = Command::new(path).arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{}\n{}", stdout, stderr);
    combined
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

fn run_command_with_logs(
    app: &AppHandle,
    mut command: Command,
    label: &str,
    ctx: &EventContext,
) -> AnyhowResult<ExitStatus> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().context("Failed to spawn command")?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let app_stdout = app.clone();
    let ctx_stdout = ctx.clone();
    let label_stdout = label.to_string();
    let out_handle = std::thread::spawn(move || {
        if let Some(out) = stdout {
            let reader = BufReader::new(out);
            for line in reader.lines().flatten() {
                let message = format!("[{}] {}", label_stdout, line);
                emit_container_log(&app_stdout, &message, &ctx_stdout);
            }
        }
    });

    let app_stderr = app.clone();
    let ctx_stderr = ctx.clone();
    let label_stderr = label.to_string();
    let err_handle = std::thread::spawn(move || {
        if let Some(err) = stderr {
            let reader = BufReader::new(err);
            for line in reader.lines().flatten() {
                let message = format!("[{}] ERROR: {}", label_stderr, line);
                emit_container_log(&app_stderr, &message, &ctx_stderr);
            }
        }
    });

    let status = child.wait().context("Command failed")?;
    let _ = out_handle.join();
    let _ = err_handle.join();
    Ok(status)
}

fn parse_limactl_json(stdout: &[u8]) -> Option<serde_json::Value> {
    let text = String::from_utf8_lossy(stdout);
    let start = text.find(|ch| ch == '{' || ch == '[')?;
    serde_json::from_str(&text[start..]).ok()
}

fn ensure_vm_running(
    app: &AppHandle,
    limactl: &Path,
    vm: &str,
    ctx: &EventContext,
) -> AnyhowResult<()> {
    ensure_lima_guest_agents(app, limactl)?;
    let template_path =
        prepare_lima_environment(app).map_err(|err| anyhow::anyhow!(err))?;
    let mut vm_exists = false;
    let mut vm_running = false;

    for args in [["list", "--json"], ["list", "--format=json"]] {
        let output = Command::new(limactl).args(args).output().ok();
        let Some(output) = output else {
            continue;
        };
        if !output.status.success() {
            continue;
        }
        let Some(value) = parse_limactl_json(&output.stdout) else {
            continue;
        };
        let mut entries: Vec<&serde_json::Value> = Vec::new();
        if let Some(array) = value.as_array() {
            entries.extend(array);
        } else if let Some(array) = value.get("items").and_then(|value| value.as_array()) {
            entries.extend(array);
        } else if let Some(array) = value
            .get("instances")
            .and_then(|value| value.as_array())
        {
            entries.extend(array);
        }

        if entries.is_empty() {
            continue;
        }

        for entry in entries {
            let name = entry
                .get("name")
                .or_else(|| entry.get("Name"))
                .and_then(|value| value.as_str());
            if name != Some(vm) {
                continue;
            }
            vm_exists = true;
            let status = entry
                .get("status")
                .or_else(|| entry.get("Status"))
                .or_else(|| entry.get("state"))
                .or_else(|| entry.get("State"))
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_lowercase();
            if status.contains("running") {
                vm_running = true;
            }
            break;
        }

        if vm_exists {
            break;
        }
    }

    if vm_exists && vm_running {
        return Ok(());
    }

    if vm_exists {
        emit_container_status(
            app,
            "starting",
            &format!("Starting Lima VM '{}'", vm),
            ctx,
        );
        let mut command = Command::new(limactl);
        command.args(["start", "--tty=false", "--mount-writable", "--mount-inotify", vm]);
        let status = run_command_with_logs(app, command, "vm-start", ctx)?;
        if status.success() {
            return Ok(());
        }
        bail!("Failed to start Lima VM '{}'", vm);
    }

    emit_container_status(
        app,
        "creating",
        &format!("Creating Lima VM '{}'", vm),
        ctx,
    );
    let mut command = Command::new(limactl);
    command.args([
        "create",
        "--name",
        vm,
        "--containerd=system",
        "--tty=false",
        "--mount-writable",
        "--mount-inotify",
    ]);
    command.arg(&template_path);
    let status = run_command_with_logs(app, command, "vm-create", ctx)?;
    if !status.success() {
        emit_container_status(
            app,
            "starting",
            &format!("Starting Lima VM '{}'", vm),
            ctx,
        );
        let mut command = Command::new(limactl);
        command.args(["start", "--tty=false", vm]);
        let status = run_command_with_logs(app, command, "vm-start", ctx)?;
        if status.success() {
            return Ok(());
        }
        bail!("Failed to create Lima VM '{}'", vm);
    }

    emit_container_status(
        app,
        "starting",
        &format!("Starting Lima VM '{}'", vm),
        ctx,
    );
    let mut command = Command::new(limactl);
    command.args(["start", "--tty=false", "--mount-writable", "--mount-inotify", vm]);
    let status = run_command_with_logs(app, command, "vm-start", ctx)?;
    if status.success() {
        return Ok(());
    }

    bail!("Failed to start Lima VM '{}'", vm)
}

fn ensure_mount_writable(
    app: &AppHandle,
    limactl: &Path,
    vm: &str,
    mount_path: &Path,
    ctx: &EventContext,
) -> AnyhowResult<()> {
    let mount_path_str = mount_path
        .to_str()
        .context("Invalid mount path")?;

    let status = Command::new(limactl)
        .args(["shell", vm, "--", "test", "-w", mount_path_str])
        .status()
        .ok();
    if let Some(status) = status {
        if status.success() {
            return Ok(());
        }
    }

    emit_container_status(
        app,
        "restarting",
        "Restarting Lima VM to enable writable mounts",
        ctx,
    );

    let stop_status = run_command_with_logs(
        app,
        {
            let mut command = Command::new(limactl);
            command.args(["stop", vm]);
            command
        },
        "vm-stop",
        ctx,
    )?;
    if !stop_status.success() {
        bail!("Failed to stop Lima VM '{}'", vm);
    }

    let start_status = run_command_with_logs(
        app,
        {
            let mut command = Command::new(limactl);
            command.args([
                "start",
                "--tty=false",
                "--mount-writable",
                "--mount-inotify",
                vm,
            ]);
            command
        },
        "vm-start",
        ctx,
    )?;
    if !start_status.success() {
        bail!("Failed to restart Lima VM '{}'", vm);
    }

    let status = Command::new(limactl)
        .args(["shell", vm, "--", "test", "-w", mount_path_str])
        .status()
        .ok();
    if let Some(status) = status {
        if status.success() {
            return Ok(());
        }
    }

    bail!("Repo mount is still read-only; delete VM '{}' and retry", vm)
}

fn nerdctl_command(limactl: &Path, vm: &str, args: &[String]) -> Command {
    let mut command = Command::new(limactl);
    command
        .arg("shell")
        .arg(vm)
        .arg("--")
        .arg("sudo")
        .arg("-n")
        .arg("nerdctl");
    command.args(args);
    command
}

fn status_to_state(status: Option<&str>) -> String {
    let Some(status) = status else {
        return "unknown".to_string();
    };
    let lower = status.to_lowercase();
    if lower.starts_with("up") || lower.contains("running") {
        "running".to_string()
    } else if lower.contains("exited")
        || lower.contains("stopped")
        || lower.contains("created")
        || lower.contains("vm stopped")
    {
        "stopped".to_string()
    } else {
        "unknown".to_string()
    }
}

#[tauri::command]
pub async fn check_lima_installed(app: AppHandle) -> Result<LimaStatus, String> {
    run_blocking(move || {
        let location = find_limactl_location(&app);
        if let Some(location) = location {
            prepare_lima_environment(&app)?;
            let mut version = limactl_version(&location.path);
            if version.is_none() && matches!(location.source, LimaSource::Bundled) {
                version = Some(format!("v{}", BUNDLED_LIMA_VERSION));
            }
            return Ok(LimaStatus {
                installed: true,
                version,
                path: Some(location.path.to_string_lossy().to_string()),
                source: Some(location.source),
            });
        }
        Ok(LimaStatus {
            installed: false,
            version: None,
            path: None,
            source: None,
        })
    })
    .await
}

pub fn launch_container(app: &AppHandle, spec: ContainerLaunchSpec) -> AnyhowResult<ContainerHandle> {
    let limactl = limactl_path(app).context(
        "Lima is unavailable. Reinstall Falck or use a build that bundles Lima.",
    )?;
    let ctx = EventContext {
        repo_path: Some(spec.repo_path.to_string_lossy().to_string()),
        app_id: spec.app_id.clone(),
        vm: Some(spec.vm.clone()),
        container: Some(spec.name.clone()),
    };
    ensure_vm_running(app, &limactl, &spec.vm, &ctx)?;

    emit_container_status(
        app,
        "building",
        &format!("Building image '{}'", spec.image),
        &ctx,
    );

    if let Some(mount_path) = spec.mounts.iter().find_map(|mount| {
        if let ContainerMountSource::Bind(path) = &mount.source {
            Some(path)
        } else {
            None
        }
    }) {
        ensure_mount_writable(app, &limactl, &spec.vm, mount_path, &ctx)?;
    }

    let cleanup_args = vec!["rm".to_string(), "-f".to_string(), spec.name.clone()];
    let _ = nerdctl_command(&limactl, &spec.vm, &cleanup_args).status();

    let build_args = vec![
        "build".to_string(),
        "--progress=plain".to_string(),
        "-t".to_string(),
        spec.image.clone(),
        "-f".to_string(),
        spec.dockerfile_path.to_string_lossy().to_string(),
        spec.context_dir.to_string_lossy().to_string(),
    ];
    let build_status = run_command_with_logs(
        app,
        nerdctl_command(&limactl, &spec.vm, &build_args),
        "build",
        &ctx,
    )?;
    if !build_status.success() {
        bail!("Container build failed");
    }

    emit_container_status(
        app,
        "starting",
        &format!("Starting container '{}'", spec.name),
        &ctx,
    );

    let mut run_args = vec![
        "run".to_string(),
        "-d".to_string(),
        "--name".to_string(),
        spec.name.clone(),
    ];

    if !spec.workdir.trim().is_empty() {
        run_args.push("-w".to_string());
        run_args.push(spec.workdir.clone());
    }

    for port in &spec.ports {
        run_args.push("-p".to_string());
        run_args.push(port.clone());
    }

    for mount in &spec.mounts {
        let mut mount_value = match &mount.source {
            ContainerMountSource::Bind(path) => {
                format!("{}:{}", path.display(), mount.target)
            }
            ContainerMountSource::Volume(volume) => {
                format!("{}:{}", volume, mount.target)
            }
        };
        if let Some(mode) = &mount.mode {
            if !mode.trim().is_empty() {
                let trimmed = mode.trim();
                let filtered = match trimmed {
                    "delegated" | "cached" => None,
                    _ => Some(trimmed),
                };
                if let Some(value) = filtered {
                    mount_value.push(':');
                    mount_value.push_str(value);
                }
            }
        }
        run_args.push("-v".to_string());
        run_args.push(mount_value);
    }

    for (key, value) in &spec.env {
        run_args.push("-e".to_string());
        run_args.push(format!("{}={}", key, value));
    }

    run_args.push(spec.image.clone());

    let run_status = run_command_with_logs(
        app,
        nerdctl_command(&limactl, &spec.vm, &run_args),
        "run",
        &ctx,
    )?;
    if !run_status.success() {
        bail!("Container failed to start");
    }

    let log_app = app.clone();
    let log_ctx = ctx.clone();
    let log_vm = spec.vm.clone();
    let log_name = spec.name.clone();
    let log_limactl = limactl.clone();
    std::thread::spawn(move || {
        let args = vec!["logs".to_string(), "-f".to_string(), log_name.clone()];
        let command = nerdctl_command(&log_limactl, &log_vm, &args);
        let _ = run_command_with_logs(&log_app, command, "logs", &log_ctx);
    });

    emit_container_status(
        app,
        "running",
        &format!("Container '{}' running", spec.name),
        &ctx,
    );

    let repo_path_str = spec.repo_path.to_string_lossy().to_string();
    let record = StoredContainer {
        id: container_id(&repo_path_str, &spec.vm, &spec.name),
        repo_path: repo_path_str,
        app_id: spec.app_id.clone(),
        name: spec.name.clone(),
        vm: spec.vm.clone(),
        image: Some(spec.image.clone()),
        created_at: now_timestamp(),
        last_used: now_timestamp(),
    };
    storage::upsert_container(app, &record)
        .map_err(|err| anyhow::anyhow!(err))?;

    Ok(ContainerHandle {
        id: record.id,
        repo_path: record.repo_path,
        name: record.name,
        vm: record.vm,
    })
}

#[tauri::command]
pub async fn list_containers(
    app: AppHandle,
    repo_path: Option<String>,
) -> Result<Vec<ContainerInfo>, String> {
    run_blocking(move || {
        let records = storage::list_containers(&app, repo_path.as_deref())?;
        let limactl = limactl_path(&app);

        let mut vm_status: HashMap<String, String> = HashMap::new();
        if let Some(limactl) = &limactl {
            let output = Command::new(limactl).args(["list", "--json"]).output();
            if let Ok(output) = output {
                if output.status.success() {
                    if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&output.stdout) {
                        if let Some(entries) = value.as_array() {
                            for entry in entries {
                                if let (Some(name), Some(status)) = (
                                    entry
                                        .get("name")
                                        .or_else(|| entry.get("Name"))
                                        .and_then(|value| value.as_str()),
                                    entry
                                        .get("status")
                                        .or_else(|| entry.get("Status"))
                                        .and_then(|value| value.as_str()),
                                ) {
                                    vm_status.insert(name.to_string(), status.to_string());
                                }
                            }
                        }
                    }
                }
            }
        }

        let mut nerdctl_status_by_vm: HashMap<String, HashMap<String, String>> = HashMap::new();
        if let Some(limactl) = &limactl {
            for record in &records {
                let status = vm_status
                    .get(&record.vm)
                    .map(|value| value.to_lowercase())
                    .unwrap_or_else(|| "unknown".to_string());
                if status.contains("running") && !nerdctl_status_by_vm.contains_key(&record.vm) {
                    let output = Command::new(limactl)
                        .args([
                            "shell",
                            record.vm.as_str(),
                            "--",
                            "sudo",
                            "-n",
                            "nerdctl",
                            "ps",
                            "-a",
                            "--format",
                            "{{.Names}}\t{{.Status}}",
                        ])
                        .output();
                    if let Ok(output) = output {
                        if output.status.success() {
                            let stdout = String::from_utf8_lossy(&output.stdout);
                            let mut map = HashMap::new();
                            for line in stdout.lines() {
                                if let Some((name, status)) = line.split_once('\t') {
                                    map.insert(name.to_string(), status.to_string());
                                }
                            }
                            nerdctl_status_by_vm.insert(record.vm.clone(), map);
                        }
                    }
                }
            }
        }

        let mut list = Vec::new();
        for record in records {
            let mut status = None;
            if limactl.is_none() {
                status = None;
            } else {
                let vm_state = vm_status
                    .get(&record.vm)
                    .map(|value| value.to_lowercase())
                    .unwrap_or_else(|| "unknown".to_string());
                if !vm_state.contains("running") {
                    status = Some("VM stopped".to_string());
                } else if let Some(status_map) = nerdctl_status_by_vm.get(&record.vm) {
                    status = status_map.get(&record.name).cloned();
                }
            }

            let state = status_to_state(status.as_deref());
            list.push(ContainerInfo {
                id: record.id,
                repo_path: record.repo_path,
                app_id: record.app_id,
                name: record.name,
                vm: record.vm,
                image: record.image,
                status,
                state,
                last_used: record.last_used,
            });
        }

        Ok(list)
    })
    .await
}

#[tauri::command]
pub async fn start_container(
    app: AppHandle,
    id: String,
    vm: String,
    name: String,
) -> Result<String, String> {
    run_blocking(move || {
        let limactl = limactl_path(&app).ok_or_else(|| {
            "Lima is unavailable. Reinstall Falck or use a build that bundles Lima."
                .to_string()
        })?;
        let record = storage::list_containers(&app, None)
            .ok()
            .and_then(|records| records.into_iter().find(|record| record.id == id));
        let ctx = EventContext {
            repo_path: record.as_ref().map(|record| record.repo_path.clone()),
            app_id: record.as_ref().and_then(|record| record.app_id.clone()),
            vm: Some(vm.clone()),
            container: Some(name.clone()),
        };
        ensure_vm_running(&app, &limactl, &vm, &ctx).map_err(|e| e.to_string())?;
        emit_container_status(
            &app,
            "starting",
            &format!("Starting container '{}'", name),
            &ctx,
        );

        let args = vec!["start".to_string(), name.clone()];
        let status = nerdctl_command(&limactl, &vm, &args)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!("Failed to start container '{}'", name));
        }

        if let Some(existing) = record {
            let record = StoredContainer {
                last_used: now_timestamp(),
                ..existing
            };
            let _ = storage::upsert_container(&app, &record);
        }

        emit_container_status(&app, "running", "Container running", &ctx);
        Ok("Container started".to_string())
    })
    .await
}

#[tauri::command]
pub async fn stop_container(
    app: AppHandle,
    id: String,
    vm: String,
    name: String,
) -> Result<String, String> {
    run_blocking(move || {
        let limactl = limactl_path(&app).ok_or_else(|| {
            "Lima is unavailable. Reinstall Falck or use a build that bundles Lima."
                .to_string()
        })?;
        let record = storage::list_containers(&app, None)
            .ok()
            .and_then(|records| records.into_iter().find(|record| record.id == id));
        let ctx = EventContext {
            repo_path: record.as_ref().map(|record| record.repo_path.clone()),
            app_id: record.as_ref().and_then(|record| record.app_id.clone()),
            vm: Some(vm.clone()),
            container: Some(name.clone()),
        };
        ensure_vm_running(&app, &limactl, &vm, &ctx).map_err(|e| e.to_string())?;
        emit_container_status(
            &app,
            "stopping",
            &format!("Stopping container '{}'", name),
            &ctx,
        );

        let args = vec!["stop".to_string(), name.clone()];
        let status = nerdctl_command(&limactl, &vm, &args)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!("Failed to stop container '{}'", name));
        }

        if let Some(existing) = record {
            let record = StoredContainer {
                last_used: now_timestamp(),
                ..existing
            };
            let _ = storage::upsert_container(&app, &record);
        }

        emit_container_status(&app, "stopped", "Container stopped", &ctx);
        Ok("Container stopped".to_string())
    })
    .await
}

#[tauri::command]
pub async fn delete_container(
    app: AppHandle,
    id: String,
    vm: String,
    name: String,
) -> Result<String, String> {
    run_blocking(move || {
        let limactl = limactl_path(&app).ok_or_else(|| {
            "Lima is unavailable. Reinstall Falck or use a build that bundles Lima."
                .to_string()
        })?;
        let record = storage::list_containers(&app, None)
            .ok()
            .and_then(|records| records.into_iter().find(|record| record.id == id));
        let ctx = EventContext {
            repo_path: record.as_ref().map(|record| record.repo_path.clone()),
            app_id: record.as_ref().and_then(|record| record.app_id.clone()),
            vm: Some(vm.clone()),
            container: Some(name.clone()),
        };
        ensure_vm_running(&app, &limactl, &vm, &ctx).map_err(|e| e.to_string())?;
        emit_container_status(
            &app,
            "stopping",
            &format!("Removing container '{}'", name),
            &ctx,
        );

        let args = vec!["rm".to_string(), "-f".to_string(), name.clone()];
        let status = nerdctl_command(&limactl, &vm, &args)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!("Failed to remove container '{}'", name));
        }

        storage::remove_container(&app, &id)?;
        emit_container_status(&app, "removed", "Container removed", &ctx);
        Ok("Container removed".to_string())
    })
    .await
}
