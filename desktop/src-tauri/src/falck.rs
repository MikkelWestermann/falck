use anyhow::{anyhow, bail, Context, Result};
use lazy_static::lazy_static;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::io::{BufRead, BufReader, Read};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

use crate::blocking::{run_blocking, run_blocking_value};
use crate::backend::{self, BackendContext, BackendProcess, VmProcessHandle};

lazy_static! {
    static ref SECRETS_STORE: Mutex<HashMap<String, String>> = Mutex::new(HashMap::new());
}

static SHELL_ENV_CACHE: OnceLock<Mutex<Option<HashMap<String, String>>>> = OnceLock::new();
const VM_ENV_TIMEOUT_SECS: u32 = 20;

#[derive(Debug, Clone)]
pub struct RunningFalckApp {
    pub process: BackendProcess,
}

pub struct FalckProcessState(pub Mutex<HashMap<u32, RunningFalckApp>>);

impl Default for FalckProcessState {
    fn default() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

fn register_running_app(state: &FalckProcessState, app: RunningFalckApp) {
    let pid = backend_process_pid(&app.process);
    let mut guard = match state.0.lock() {
        Ok(guard) => guard,
        Err(err) => err.into_inner(),
    };
    guard.insert(pid, app);
}

fn unregister_running_app(state: &FalckProcessState, pid: u32) -> Option<RunningFalckApp> {
    let mut guard = match state.0.lock() {
        Ok(guard) => guard,
        Err(err) => err.into_inner(),
    };
    guard.remove(&pid)
}

fn backend_process_pid(process: &BackendProcess) -> u32 {
    match process {
        BackendProcess::Host { pid } => *pid,
        BackendProcess::Virtualized { pid, vm } => {
            let input = format!("{}:{}", vm.name, pid);
            let hash = fnv1a_hash_u32(&input);
            0x8000_0000 | hash
        }
    }
}

fn fnv1a_hash_u32(value: &str) -> u32 {
    let mut hash: u32 = 0x811c9dc5;
    for byte in value.as_bytes() {
        hash ^= *byte as u32;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

fn kill_backend_process(process: BackendProcess) -> Result<()> {
    match process {
        BackendProcess::Host { pid } => kill_app(pid),
        BackendProcess::Virtualized { pid, vm } => {
            backend::kill_vm_process(&vm, pid).map_err(|err| anyhow!(err))
        }
    }
}

pub fn stop_all_running_apps(state: &FalckProcessState) {
    let running = {
        let mut guard = match state.0.lock() {
            Ok(guard) => guard,
            Err(err) => err.into_inner(),
        };
        guard.drain().map(|(_, app)| app).collect::<Vec<_>>()
    };

    for app in running {
        let _ = kill_backend_process(app.process);
    }
}

// ============================================================================
// Falck Config Types
// ============================================================================

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FalckConfig {
    pub version: String,
    pub metadata: Option<ConfigMetadata>,
    pub repository: Option<RepositoryConfig>,
    pub applications: Vec<Application>,
    pub global_env: Option<HashMap<String, String>>,
    pub install_order: Option<Vec<String>>,
    pub launch_order: Option<Vec<String>>,
    pub groups: Option<Vec<AppGroup>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConfigMetadata {
    pub name: Option<String>,
    pub description: Option<String>,
    pub author: Option<String>,
    pub created: Option<String>,
    pub updated: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RepositoryConfig {
    pub default_branch: Option<String>,
    pub protect_default_branch: Option<bool>,
    pub branch_prefix: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Application {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub app_type: String,
    pub description: Option<String>,
    pub root: String,
    pub assets: Option<AssetsConfig>,
    pub secrets: Option<Vec<Secret>>,
    pub setup: Option<SetupConfig>,
    pub launch: LaunchConfig,
    pub cleanup: Option<CleanupConfig>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AssetsConfig {
    pub root: String,
    pub subdirectories: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(untagged)]
pub enum CommandSequence {
    Single(String),
    Multiple(Vec<CommandOperation>),
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(untagged)]
pub enum CommandOperation {
    Command(String),
    Detailed(CommandOperationConfig),
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CommandOperationConfig {
    pub command: String,
    pub refresh_shell: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Secret {
    pub name: String,
    pub description: String,
    pub required: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SetupConfig {
    pub steps: Option<Vec<SetupStep>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SetupStep {
    pub name: String,
    pub command: CommandSequence,
    pub description: Option<String>,
    pub timeout: Option<u32>,
    pub silent: Option<bool>,
    pub optional: Option<bool>,
    pub only_if: Option<String>,
    pub check: Option<SetupCheck>,
    pub teardown: Option<SetupTeardown>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SetupCheck {
    pub command: String,
    pub description: Option<String>,
    pub timeout: Option<u32>,
    pub silent: Option<bool>,
    pub only_if: Option<String>,
    pub expect: Option<String>,
    pub expect_contains: Option<String>,
    pub expect_regex: Option<String>,
    pub output: Option<String>,
    pub trim: Option<bool>,
    pub ignore_exit: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SetupTeardown {
    pub command: CommandSequence,
    pub description: Option<String>,
    pub timeout: Option<u32>,
    pub silent: Option<bool>,
    pub only_if: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SetupStepCheckResult {
    pub step_index: usize,
    pub name: String,
    pub status: String,
    pub message: Option<String>,
    pub optional: bool,
}

#[derive(Debug, Serialize, Clone)]
struct SetupStepEvent {
    repo_path: String,
    app_id: String,
    step_index: usize,
    step_name: String,
    status: String,
    message: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LaunchResult {
    pub kind: String,
    pub pid: Option<u32>,
    pub container: Option<crate::containers::ContainerHandle>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LaunchConfig {
    pub command: Option<String>,
    pub description: Option<String>,
    pub timeout: Option<u32>,
    pub access: Option<AccessConfig>,
    pub env: Option<HashMap<String, String>>,
    pub ports: Option<Vec<u16>>,
    pub container: Option<ContainerLaunchConfig>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ContainerLaunchConfig {
    pub dockerfile: String,
    pub context: Option<String>,
    pub image: Option<String>,
    pub name: Option<String>,
    pub vm: Option<String>,
    pub workdir: Option<String>,
    pub ports: Option<Vec<String>>,
    pub mounts: Option<Vec<ContainerMount>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ContainerMount {
    pub source: Option<String>,
    pub volume: Option<String>,
    pub target: String,
    pub mode: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AccessConfig {
    #[serde(rename = "type")]
    pub access_type: String,
    pub url: Option<String>,
    pub open_browser: Option<bool>,
    pub port: Option<u16>,
    pub ready_signal: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CleanupConfig {
    pub steps: Option<Vec<CleanupStep>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CleanupStep {
    pub name: String,
    pub command: String,
    pub description: Option<String>,
    pub timeout: Option<u32>,
    pub only_if: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppGroup {
    pub name: String,
    pub apps: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SetupCheckResult {
    pub status: String,
    pub message: Option<String>,
}

// ============================================================================
// Config Loading
// ============================================================================

pub fn load_config(repo_path: &Path) -> Result<FalckConfig> {
    let config_path = repo_path.join(".falck").join("config.yaml");
    if !config_path.exists() {
        bail!("No .falck/config.yaml found in repository");
    }

    let content = std::fs::read_to_string(&config_path).context("Failed to read config.yaml")?;

    let config: FalckConfig =
        serde_yaml::from_str(&content).context("Failed to parse config.yaml")?;

    if config.version != "1.0" {
        bail!("Unsupported config version: {}", config.version);
    }

    Ok(config)
}

pub fn get_app_root(repo_path: &Path, app: &Application) -> PathBuf {
    if app.root == "." {
        repo_path.to_path_buf()
    } else {
        repo_path.join(&app.root)
    }
}

// ============================================================================
// Asset Uploads
// ============================================================================

fn normalize_relative_path(value: &str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed == "." {
        return Ok(String::new());
    }

    let path = Path::new(trimmed);
    if path.is_absolute() {
        bail!("Path must be relative.");
    }

    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(os_str) => {
                let segment = os_str.to_string_lossy();
                if !segment.is_empty() {
                    parts.push(segment.to_string());
                }
            }
            Component::ParentDir => bail!("Path cannot include '..' segments."),
            Component::RootDir | Component::Prefix(_) => {
                bail!("Path must be relative.");
            }
        }
    }

    Ok(parts.join("/"))
}

fn resolve_asset_root(repo_path: &Path, app: &Application) -> Result<PathBuf> {
    let assets = app
        .assets
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("No assets configuration for this application."))?;
    let root = normalize_relative_path(&assets.root)?;
    let app_root = get_app_root(repo_path, app);
    if root.is_empty() {
        Ok(app_root)
    } else {
        Ok(app_root.join(root))
    }
}

fn resolve_asset_subdir(app: &Application, target: Option<&str>) -> Result<String> {
    let assets = app
        .assets
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("No assets configuration for this application."))?;
    let normalized = normalize_relative_path(target.unwrap_or(""))?;

    if let Some(subdirs) = &assets.subdirectories {
        let mut allowed = Vec::with_capacity(subdirs.len());
        for subdir in subdirs {
            allowed.push(normalize_relative_path(subdir)?);
        }
        if !normalized.is_empty() && !allowed.contains(&normalized) {
            bail!("Target directory is not allowed for this application.");
        }
    }

    Ok(normalized)
}

fn validate_file_name(name: &str) -> Result<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        bail!("File name is required.");
    }

    let path = Path::new(trimmed);
    let mut components = path.components();
    let first = components
        .next()
        .ok_or_else(|| anyhow::anyhow!("Invalid file name."))?;
    if components.next().is_some() {
        bail!("File name must not include a path.");
    }

    match first {
        Component::Normal(os_str) => Ok(os_str.to_string_lossy().to_string()),
        _ => bail!("File name must not include a path."),
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AssetUploadFile {
    pub name: String,
    pub bytes: Vec<u8>,
}

pub fn upload_assets(
    repo_path: &Path,
    app: &Application,
    target_subdirectory: Option<String>,
    files: Vec<AssetUploadFile>,
) -> Result<Vec<String>> {
    if files.is_empty() {
        bail!("No files provided.");
    }

    let asset_root = resolve_asset_root(repo_path, app)?;
    let target = resolve_asset_subdir(app, target_subdirectory.as_deref())?;
    let destination_dir = if target.is_empty() {
        asset_root.clone()
    } else {
        asset_root.join(&target)
    };

    std::fs::create_dir_all(&destination_dir)
        .with_context(|| format!("Failed to create asset directory at {:?}", destination_dir))?;

    let mut saved_paths = Vec::new();
    for file in files {
        let file_name = validate_file_name(&file.name)?;
        let destination = destination_dir.join(&file_name);
        std::fs::write(&destination, file.bytes)
            .with_context(|| format!("Failed to write asset {:?}", destination))?;

        let relative = destination
            .strip_prefix(repo_path)
            .unwrap_or(&destination)
            .to_string_lossy()
            .to_string();
        saved_paths.push(relative);
    }

    Ok(saved_paths)
}

// ============================================================================
// Secrets Store
// ============================================================================

pub fn get_app_secrets(app: &Application) -> Vec<Secret> {
    app.secrets.clone().unwrap_or_default()
}

pub fn check_app_secrets_satisfied(app: &Application) -> bool {
    let secrets = get_app_secrets(app);
    let store = SECRETS_STORE.lock().unwrap();
    secrets
        .into_iter()
        .filter(|secret| secret.required)
        .all(|secret| store.contains_key(&secret.name))
}

pub fn set_secret(name: String, value: String) {
    let mut store = SECRETS_STORE.lock().unwrap();
    store.insert(name, value);
}

pub fn get_all_secrets() -> HashMap<String, String> {
    let store = SECRETS_STORE.lock().unwrap();
    store.clone()
}

pub fn clear_secrets() {
    let mut store = SECRETS_STORE.lock().unwrap();
    store.clear();
}

// ============================================================================
// Setup Step Checks
// ============================================================================

fn run_setup_check(
    app_root: &Path,
    ctx: &TemplateContext,
    env_map: &HashMap<String, String>,
    backend: &BackendContext,
    check: &SetupCheck,
) -> SetupCheckResult {
    if let Some(condition) = &check.only_if {
        match evaluate_condition(condition, ctx) {
            Ok(true) => {}
            Ok(false) => {
                return SetupCheckResult {
                    status: "skipped".to_string(),
                    message: Some("Setup check skipped for this environment.".to_string()),
                };
            }
            Err(err) => {
                return SetupCheckResult {
                    status: "error".to_string(),
                    message: Some(err.to_string()),
                };
            }
        }
    }

    let expectation_count = check.expect.is_some() as u8
        + check.expect_contains.is_some() as u8
        + check.expect_regex.is_some() as u8;
    if expectation_count > 1 {
        return SetupCheckResult {
            status: "error".to_string(),
            message: Some(
                "Setup check has multiple expectations. Use only one of expect, expect_contains, or expect_regex."
                    .to_string(),
            ),
        };
    }

    let command = match resolve_template(&check.command, ctx) {
        Ok(value) => value,
        Err(err) => {
            return SetupCheckResult {
                status: "error".to_string(),
                message: Some(err.to_string()),
            };
        }
    };
    let timeout = check.timeout.unwrap_or(30);
    let ignore_exit = check.ignore_exit.unwrap_or(false);
    let trim_output = check.trim.unwrap_or(true);
    let output_mode = check.output.clone().unwrap_or_else(|| "stdout".to_string());

    match run_command_capture_backend(backend, &command, &app_root, env_map, Some(timeout)) {
        Ok((status, stdout, stderr)) => {
            if !status.success() && !ignore_exit {
                return SetupCheckResult {
                    status: "error".to_string(),
                    message: Some("Setup check command failed.".to_string()),
                };
            }

            let mut output = match output_mode.as_str() {
                "stderr" => stderr,
                "combined" => {
                    if stdout.is_empty() {
                        stderr
                    } else if stderr.is_empty() {
                        stdout
                    } else {
                        format!("{}\n{}", stdout, stderr)
                    }
                }
                _ => stdout,
            };

            if trim_output {
                output = output.trim().to_string();
            }

            let matched = if let Some(expect) = &check.expect {
                output == *expect
            } else if let Some(expect_contains) = &check.expect_contains {
                output.contains(expect_contains)
            } else if let Some(expect_regex) = &check.expect_regex {
                match Regex::new(expect_regex) {
                    Ok(re) => re.is_match(&output),
                    Err(err) => {
                        return SetupCheckResult {
                            status: "error".to_string(),
                            message: Some(format!("Invalid setup check regex: {}", err)),
                        };
                    }
                }
            } else {
                status.success()
            };

            let complete = if expectation_count == 0 {
                status.success()
            } else {
                matched
            };

            let message = if complete {
                check
                    .description
                    .clone()
                    .or_else(|| Some("Setup check passed.".to_string()))
            } else if expectation_count > 0 {
                Some("Setup check did not match expected output.".to_string())
            } else {
                Some("Setup check failed.".to_string())
            };

            SetupCheckResult {
                status: if complete {
                    "complete".to_string()
                } else {
                    "incomplete".to_string()
                },
                message,
            }
        }
        Err(err) => SetupCheckResult {
            status: "error".to_string(),
            message: Some(err.to_string()),
        },
    }
}

pub fn check_setup_steps(
    repo_path: &Path,
    config: &FalckConfig,
    app: &Application,
    backend: &BackendContext,
) -> Result<Vec<SetupStepCheckResult>> {
    let mut results = Vec::new();
    if backend.mode == backend::BackendMode::Host {
        let _ = refresh_shell_env_cache();
    }
    let (app_root, ctx, env_map) = prepare_runtime_context(repo_path, config, app, backend)?;
    let Some(setup) = &app.setup else {
        return Ok(results);
    };
    let Some(steps) = &setup.steps else {
        return Ok(results);
    };

    for (index, step) in steps.iter().enumerate() {
        if let Some(condition) = &step.only_if {
            if !evaluate_condition(condition, &ctx)? {
                results.push(SetupStepCheckResult {
                    step_index: index,
                    name: step.name.clone(),
                    status: "skipped".to_string(),
                    message: Some("Skipped for this environment.".to_string()),
                    optional: step.optional.unwrap_or(false),
                });
                continue;
            }
        }

        let Some(check) = &step.check else {
            results.push(SetupStepCheckResult {
                step_index: index,
                name: step.name.clone(),
                status: "missing_check".to_string(),
                message: Some("No check configured for this step.".to_string()),
                optional: step.optional.unwrap_or(false),
            });
            continue;
        };

        let check_result = run_setup_check(&app_root, &ctx, &env_map, backend, check);
        results.push(SetupStepCheckResult {
            step_index: index,
            name: step.name.clone(),
            status: check_result.status,
            message: check_result.message,
            optional: step.optional.unwrap_or(false),
        });
    }

    Ok(results)
}

#[derive(Debug, Clone)]
struct ResolvedCommandOperation {
    command: String,
    refresh_shell: bool,
}

fn expand_command_sequence(command: &CommandSequence) -> Vec<ResolvedCommandOperation> {
    match command {
        CommandSequence::Single(command) => vec![ResolvedCommandOperation {
            command: command.clone(),
            refresh_shell: false,
        }],
        CommandSequence::Multiple(operations) => operations
            .iter()
            .map(|operation| match operation {
                CommandOperation::Command(command) => ResolvedCommandOperation {
                    command: command.clone(),
                    refresh_shell: false,
                },
                CommandOperation::Detailed(detail) => ResolvedCommandOperation {
                    command: detail.command.clone(),
                    refresh_shell: detail.refresh_shell.unwrap_or(false),
                },
            })
            .collect(),
    }
}

fn refresh_runtime_context(
    repo_path: &Path,
    config: &FalckConfig,
    app: &Application,
    backend: &BackendContext,
) -> Result<(TemplateContext, HashMap<String, String>)> {
    if backend.mode == backend::BackendMode::Host {
        let _ = refresh_shell_env_cache();
    }
    let (_, ctx, env_map) = prepare_runtime_context(repo_path, config, app, backend)?;
    Ok((ctx, env_map))
}

// ============================================================================
// Setup / Launch / Cleanup
// ============================================================================

pub fn run_setup(
    repo_path: &Path,
    config: &FalckConfig,
    app: &Application,
    backend: &BackendContext,
    app_handle: Option<&AppHandle>,
) -> Result<String> {
    if !check_app_secrets_satisfied(app) {
        bail!("Required secrets not configured for this application");
    }

    let app_root = get_app_root(repo_path, app);
    let refresh_each_step = backend.vm.is_some();
    let (mut ctx, mut env_map) = {
        let (_, ctx, env_map) = prepare_runtime_context(repo_path, config, app, backend)?;
        (ctx, env_map)
    };

    if let Some(setup) = &app.setup {
        if let Some(steps) = &setup.steps {
            for (index, step) in steps.iter().enumerate() {
                if refresh_each_step && index > 0 {
                    let (_, refreshed_ctx, refreshed_env) =
                        prepare_runtime_context(repo_path, config, app, backend)?;
                    ctx = refreshed_ctx;
                    env_map = refreshed_env;
                }
                if let Some(condition) = &step.only_if {
                    if !evaluate_condition(condition, &ctx)? {
                        emit_setup_step_event(
                            app_handle,
                            repo_path,
                            &app.id,
                            index,
                            &step.name,
                            "skipped",
                            Some("Condition unmet.".to_string()),
                        );
                        emit_vm_log_entry(
                            app_handle,
                            backend,
                            "setup",
                            &format!("[setup:{}] Skipped (condition unmet)", step.name),
                        );
                        continue;
                    }
                }

                let timeout = step.timeout.unwrap_or(300);
                let silent = step.silent.unwrap_or(false);
                let operations = expand_command_sequence(&step.command);
                let has_multiple = operations.len() > 1;
                let mut step_failed = false;

                emit_setup_step_event(
                    app_handle,
                    repo_path,
                    &app.id,
                    index,
                    &step.name,
                    "started",
                    None,
                );

                for (operation_index, operation) in operations.iter().enumerate() {
                    let command = resolve_template(&operation.command, &ctx)?;
                    let label = if has_multiple {
                        format!("setup:{}:{}", step.name, operation_index + 1)
                    } else {
                        format!("setup:{}", step.name)
                    };
                    let status = run_command_backend_with_vm_logs(
                        app_handle,
                        backend,
                        "setup",
                        &label,
                        &command,
                        &app_root,
                        &env_map,
                        Some(timeout),
                        silent,
                    )?;

                    if !status.success() {
                        if step.optional.unwrap_or(false) {
                            emit_setup_step_event(
                                app_handle,
                                repo_path,
                                &app.id,
                                index,
                                &step.name,
                                "skipped",
                                Some("Optional step failed.".to_string()),
                            );
                            emit_vm_log_entry(
                                app_handle,
                                backend,
                                "setup",
                                &format!(
                                    "[setup:{}] Failed but marked optional, continuing",
                                    step.name
                                ),
                            );
                            step_failed = true;
                            break;
                        }
                        emit_setup_step_event(
                            app_handle,
                            repo_path,
                            &app.id,
                            index,
                            &step.name,
                            "failed",
                            Some("Command failed.".to_string()),
                        );
                        bail!("Setup step '{}' failed", step.name);
                    }

                    if operation.refresh_shell {
                        let (refreshed_ctx, refreshed_env) =
                            refresh_runtime_context(repo_path, config, app, backend)?;
                        ctx = refreshed_ctx;
                        env_map = refreshed_env;
                    }
                }

                if step_failed {
                    continue;
                }

                emit_setup_step_event(
                    app_handle,
                    repo_path,
                    &app.id,
                    index,
                    &step.name,
                    "completed",
                    None,
                );
            }
        }
    }

    Ok("Setup completed successfully".to_string())
}

pub fn run_setup_step(
    repo_path: &Path,
    config: &FalckConfig,
    app: &Application,
    step_index: usize,
    backend: &BackendContext,
    app_handle: Option<&AppHandle>,
) -> Result<String> {
    if !check_app_secrets_satisfied(app) {
        bail!("Required secrets not configured for this application");
    }

    let Some(setup) = &app.setup else {
        bail!("No setup configured for this application");
    };
    let Some(steps) = &setup.steps else {
        bail!("No setup steps configured for this application");
    };
    let step = steps.get(step_index).context("Setup step not found")?;

    let app_root = get_app_root(repo_path, app);
    let (mut ctx, mut env_map) = {
        let (_, ctx, env_map) = prepare_runtime_context(repo_path, config, app, backend)?;
        (ctx, env_map)
    };

    if let Some(condition) = &step.only_if {
        if !evaluate_condition(condition, &ctx)? {
            emit_setup_step_event(
                app_handle,
                repo_path,
                &app.id,
                step_index,
                &step.name,
                "skipped",
                Some("Condition unmet.".to_string()),
            );
            return Ok("Setup step skipped for this environment.".to_string());
        }
    }

    let timeout = step.timeout.unwrap_or(300);
    let silent = step.silent.unwrap_or(false);
    let operations = expand_command_sequence(&step.command);
    let has_multiple = operations.len() > 1;

    emit_setup_step_event(
        app_handle,
        repo_path,
        &app.id,
        step_index,
        &step.name,
        "started",
        None,
    );

    for (operation_index, operation) in operations.iter().enumerate() {
        let command = resolve_template(&operation.command, &ctx)?;
        let label = if has_multiple {
            format!("setup:{}:{}", step.name, operation_index + 1)
        } else {
            format!("setup:{}", step.name)
        };
        let status = run_command_backend_with_vm_logs(
            app_handle,
            backend,
            "setup",
            &label,
            &command,
            &app_root,
            &env_map,
            Some(timeout),
            silent,
        )?;

        if !status.success() {
            if step.optional.unwrap_or(false) {
                emit_setup_step_event(
                    app_handle,
                    repo_path,
                    &app.id,
                    step_index,
                    &step.name,
                    "skipped",
                    Some("Optional step failed.".to_string()),
                );
                return Ok("Optional step failed; skipping.".to_string());
            }
            emit_setup_step_event(
                app_handle,
                repo_path,
                &app.id,
                step_index,
                &step.name,
                "failed",
                Some("Command failed.".to_string()),
            );
            bail!("Setup step '{}' failed", step.name);
        }

        if operation.refresh_shell {
            let (refreshed_ctx, refreshed_env) =
                refresh_runtime_context(repo_path, config, app, backend)?;
            ctx = refreshed_ctx;
            env_map = refreshed_env;
        }
    }

    emit_setup_step_event(
        app_handle,
        repo_path,
        &app.id,
        step_index,
        &step.name,
        "completed",
        None,
    );

    Ok(format!("Ran setup step '{}'.", step.name))
}

pub fn run_setup_step_teardown(
    repo_path: &Path,
    config: &FalckConfig,
    app: &Application,
    step_index: usize,
    backend: &BackendContext,
) -> Result<String> {
    let Some(setup) = &app.setup else {
        bail!("No setup configured for this application");
    };
    let Some(steps) = &setup.steps else {
        bail!("No setup steps configured for this application");
    };
    let step = steps.get(step_index).context("Setup step not found")?;
    let teardown = step
        .teardown
        .as_ref()
        .context("No teardown configured for this step")?;

    let app_root = get_app_root(repo_path, app);
    let (mut ctx, mut env_map) = {
        let (_, ctx, env_map) = prepare_runtime_context(repo_path, config, app, backend)?;
        (ctx, env_map)
    };

    if let Some(condition) = &step.only_if {
        if !evaluate_condition(condition, &ctx)? {
            return Ok("Teardown skipped for this environment.".to_string());
        }
    }

    if let Some(condition) = &teardown.only_if {
        if !evaluate_condition(condition, &ctx)? {
            return Ok("Teardown skipped for this environment.".to_string());
        }
    }

    let timeout = teardown.timeout.unwrap_or(300);
    let silent = teardown.silent.unwrap_or(false);
    let operations = expand_command_sequence(&teardown.command);
    let has_multiple = operations.len() > 1;

    for (operation_index, operation) in operations.iter().enumerate() {
        let command = resolve_template(&operation.command, &ctx)?;
        let label = if has_multiple {
            format!("teardown:{}:{}", step.name, operation_index + 1)
        } else {
            format!("teardown:{}", step.name)
        };
        let status = run_command_backend_with_vm_logs(
            None,
            backend,
            "teardown",
            &label,
            &command,
            &app_root,
            &env_map,
            Some(timeout),
            silent,
        )?;

        if !status.success() {
            bail!("Teardown for '{}' failed", step.name);
        }

        if operation.refresh_shell {
            let (refreshed_ctx, refreshed_env) =
                refresh_runtime_context(repo_path, config, app, backend)?;
            ctx = refreshed_ctx;
            env_map = refreshed_env;
        }
    }

    Ok(format!("Ran teardown for '{}'.", step.name))
}

pub fn launch_app(
    repo_path: &Path,
    config: &FalckConfig,
    app: &Application,
    backend: &BackendContext,
) -> Result<BackendProcess> {
    if !check_app_secrets_satisfied(app) {
        bail!("Required secrets not configured for this application");
    }

    let (app_root, ctx, env_map) = prepare_runtime_context(repo_path, config, app, backend)?;
    let command = app
        .launch
        .command
        .as_ref()
        .context("Launch command missing for this application")?;
    let command = resolve_template(command, &ctx)?;

    if let Some(vm) = &backend.vm {
        let exports = backend::vm_env_exports(&env_map);
        let vm_root = backend::vm_app_root(vm, &app_root).map_err(|err| anyhow!(err))?;
        let script = format!(
            "{}cd {} && {}",
            exports,
            backend::shell_escape(&vm_root),
            backend::background_launch_script(&command)
        );
        let cmd = backend::build_vm_command(vm, &script);
        let (status, stdout, stderr) =
            backend::spawn_capture_with_timeout(cmd, Some(20)).map_err(|err| anyhow!(err))?;
        if !status.success() {
            let combined = format!("{}\n{}", stdout.trim(), stderr.trim())
                .trim()
                .to_string();
            let message = if combined.is_empty() {
                "Failed to launch application inside VM.".to_string()
            } else {
                combined
            };
            bail!(message);
        }
        let pid = backend::extract_pid(&format!("{}\n{}", stdout, stderr))
            .map_err(|err| anyhow!(err))?;
        Ok(BackendProcess::Virtualized {
            pid,
            vm: VmProcessHandle {
                provider: vm.provider,
                name: vm.name.clone(),
                limactl_path: vm.limactl_path.clone(),
            },
        })
    } else {
        let mut cmd = build_shell_command(&command);
        cmd.current_dir(&app_root)
            .envs(&env_map)
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        let child = cmd.spawn().context("Failed to spawn application process")?;
        Ok(BackendProcess::Host { pid: child.id() })
    }
}

pub fn run_cleanup(
    repo_path: &Path,
    config: &FalckConfig,
    app: &Application,
    backend: &BackendContext,
) -> Result<String> {
    let app_root = get_app_root(repo_path, app);
    let refresh_each_step = backend.vm.is_some();
    let (mut ctx, mut env_map) = {
        let (_, ctx, env_map) = prepare_runtime_context(repo_path, config, app, backend)?;
        (ctx, env_map)
    };

    if let Some(cleanup) = &app.cleanup {
        if let Some(steps) = &cleanup.steps {
            for (index, step) in steps.iter().enumerate() {
                if refresh_each_step && index > 0 {
                    let (_, refreshed_ctx, refreshed_env) =
                        prepare_runtime_context(repo_path, config, app, backend)?;
                    ctx = refreshed_ctx;
                    env_map = refreshed_env;
                }
                if let Some(condition) = &step.only_if {
                    if !evaluate_condition(condition, &ctx)? {
                        continue;
                    }
                }

                let command = resolve_template(&step.command, &ctx)?;
                let timeout = step.timeout.unwrap_or(30);
                let status = run_command_backend(
                    backend,
                    &command,
                    &app_root,
                    &env_map,
                    Some(timeout),
                    true,
                )?;
                if !status.success() {
                    bail!("Cleanup step '{}' failed", step.name);
                }
            }
        }
    }

    Ok("Cleanup completed successfully".to_string())
}

fn merge_shell_env(env_map: &mut HashMap<String, String>, shell_env: HashMap<String, String>) {
    for (key, value) in shell_env {
        if key == "PATH" {
            env_map.insert(key, value);
        } else {
            env_map.entry(key).or_insert(value);
        }
    }
}

fn load_backend_env(backend: &BackendContext) -> HashMap<String, String> {
    if backend.mode == backend::BackendMode::Host {
        let mut env_map: HashMap<String, String> = env::vars().collect();
        if !cfg!(debug_assertions) {
            if let Some(shell_env) = load_shell_env() {
                merge_shell_env(&mut env_map, shell_env);
            }
        }
        env_map
    } else {
        backend
            .vm
            .as_ref()
            .and_then(load_vm_shell_env)
            .unwrap_or_default()
    }
}

fn resolve_runtime_paths(
    repo_path: &Path,
    app_root: &Path,
    backend: &BackendContext,
) -> Result<(PathBuf, PathBuf)> {
    match backend.mode {
        backend::BackendMode::Host => Ok((repo_path.to_path_buf(), app_root.to_path_buf())),
        backend::BackendMode::Virtualized => {
            let vm = backend
                .vm
                .as_ref()
                .context("Virtualized backend not initialized")?;
            let repo_root = PathBuf::from(&vm.repo_root);
            let app_root = backend::vm_app_root(vm, app_root).map_err(|e| anyhow!(e))?;
            Ok((repo_root, PathBuf::from(app_root)))
        }
    }
}

fn prepare_runtime_context(
    repo_path: &Path,
    config: &FalckConfig,
    app: &Application,
    backend: &BackendContext,
) -> Result<(PathBuf, TemplateContext, HashMap<String, String>)> {
    let app_root = get_app_root(repo_path, app);
    let base_env = load_backend_env(backend);
    let (ctx_repo_root, ctx_app_root) = resolve_runtime_paths(repo_path, &app_root, backend)?;
    let ctx = TemplateContext::new_for_backend(&ctx_repo_root, &ctx_app_root, &base_env, backend);
    let env_map = build_env_map(config, app, &ctx, &base_env)?;
    Ok((app_root, ctx, env_map))
}

fn build_env_map(
    config: &FalckConfig,
    app: &Application,
    ctx: &TemplateContext,
    base_env: &HashMap<String, String>,
) -> Result<HashMap<String, String>> {
    let mut env_map: HashMap<String, String> = base_env.clone();

    if let Some(global_env) = &config.global_env {
        for (key, value) in global_env {
            env_map.insert(key.clone(), resolve_template(value, ctx)?);
        }
    }

    if let Some(launch_env) = &app.launch.env {
        for (key, value) in launch_env {
            env_map.insert(key.clone(), resolve_template(value, ctx)?);
        }
    }

    env_map.extend(get_all_secrets());
    Ok(env_map)
}

fn build_container_env_map(
    config: &FalckConfig,
    app: &Application,
    ctx: &TemplateContext,
) -> Result<HashMap<String, String>> {
    let mut env_map: HashMap<String, String> = HashMap::new();

    if let Some(global_env) = &config.global_env {
        for (key, value) in global_env {
            env_map.insert(key.clone(), resolve_template(value, ctx)?);
        }
    }

    if let Some(launch_env) = &app.launch.env {
        for (key, value) in launch_env {
            env_map.insert(key.clone(), resolve_template(value, ctx)?);
        }
    }

    env_map.extend(get_all_secrets());
    Ok(env_map)
}

fn normalize_container_name(input: &str) -> String {
    let mut output = String::new();
    let mut last_dash = false;
    for ch in input.chars() {
        let candidate = ch.to_ascii_lowercase();
        if candidate.is_ascii_alphanumeric() || candidate == '.' || candidate == '_' || candidate == '-' {
            if candidate == '-' {
                if !last_dash {
                    output.push(candidate);
                }
                last_dash = true;
            } else {
                output.push(candidate);
                last_dash = false;
            }
        } else if !last_dash {
            output.push('-');
            last_dash = true;
        }
    }

    let trimmed = output.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "falck-app".to_string()
    } else {
        trimmed
    }
}

fn default_container_name(repo_path: &Path, app: &Application) -> String {
    let repo_name = repo_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("repo");
    normalize_container_name(&format!("falck-{}-{}", repo_name, app.id))
}

fn resolve_path_from_app_root(input: &str, app_root: &Path) -> PathBuf {
    let path = PathBuf::from(input);
    if path.is_absolute() {
        path
    } else {
        app_root.join(path)
    }
}

fn build_container_launch_spec(
    repo_path: &Path,
    config: &FalckConfig,
    app: &Application,
) -> Result<crate::containers::ContainerLaunchSpec> {
    let container = app
        .launch
        .container
        .as_ref()
        .context("Container launch configuration missing")?;

    let app_root = get_app_root(repo_path, app);
    let ctx = TemplateContext::new(repo_path, &app_root);

    let dockerfile_template = resolve_template(&container.dockerfile, &ctx)?;
    let dockerfile_path = resolve_path_from_app_root(&dockerfile_template, &app_root);

    let context_template = resolve_template(container.context.as_deref().unwrap_or("."), &ctx)?;
    let context_dir = resolve_path_from_app_root(&context_template, &app_root);

    let default_name = default_container_name(repo_path, app);
    let name = container
        .name
        .clone()
        .map(|value| normalize_container_name(&value))
        .unwrap_or_else(|| default_name.clone());
    let image = container
        .image
        .clone()
        .unwrap_or_else(|| default_name.clone());
    let vm = container
        .vm
        .clone()
        .unwrap_or_else(|| "falck-dev".to_string());
    let workdir = container
        .workdir
        .clone()
        .unwrap_or_else(|| "/app".to_string());

    let ports = if let Some(ports) = &container.ports {
        ports.clone()
    } else if let Some(ports) = &app.launch.ports {
        ports.iter().map(|port| format!("{0}:{0}", port)).collect()
    } else if let Some(access) = &app.launch.access {
        if let Some(port) = access.port {
            vec![format!("{0}:{0}", port)]
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };

    let mounts = if let Some(mounts) = &container.mounts {
        mounts
            .iter()
            .map(|mount| {
                match (&mount.source, &mount.volume) {
                    (Some(source), None) => {
                        let source_template = resolve_template(source, &ctx)?;
                        let source_path =
                            resolve_path_from_app_root(&source_template, &app_root);
                        Ok(crate::containers::ContainerMountSpec {
                            source: crate::containers::ContainerMountSource::Bind(source_path),
                            target: mount.target.clone(),
                            mode: mount.mode.clone(),
                        })
                    }
                    (None, Some(volume)) => Ok(crate::containers::ContainerMountSpec {
                        source: crate::containers::ContainerMountSource::Volume(volume.clone()),
                        target: mount.target.clone(),
                        mode: mount.mode.clone(),
                    }),
                    (Some(_), Some(_)) => Err(anyhow::anyhow!(
                        "Container mounts must specify either source or volume, not both"
                    )),
                    (None, None) => Err(anyhow::anyhow!(
                        "Container mounts must specify a source or a volume"
                    )),
                }
            })
            .collect::<Result<Vec<_>>>()?
    } else {
        vec![crate::containers::ContainerMountSpec {
            source: crate::containers::ContainerMountSource::Bind(app_root.clone()),
            target: "/app".to_string(),
            mode: Some("delegated".to_string()),
        }]
    };

    let env = build_container_env_map(config, app, &ctx)?;

    Ok(crate::containers::ContainerLaunchSpec {
        repo_path: repo_path.to_path_buf(),
        app_id: Some(app.id.clone()),
        vm,
        name,
        image,
        dockerfile_path,
        context_dir,
        ports,
        mounts,
        env,
        workdir,
    })
}

fn run_command_backend(
    backend: &BackendContext,
    command: &str,
    cwd: &Path,
    env_map: &HashMap<String, String>,
    timeout_secs: Option<u32>,
    silent: bool,
) -> Result<ExitStatus> {
    if let Some(vm) = &backend.vm {
        let vm_cwd = backend::vm_app_root(vm, cwd).map_err(|err| anyhow!(err))?;
        let exports = backend::vm_env_exports(env_map);
        let script = format!(
            "{}cd {} && {}",
            exports,
            backend::shell_escape(&vm_cwd),
            command
        );
        let cmd = backend::build_vm_command(vm, &script);
        let status = backend::spawn_with_timeout(cmd, timeout_secs, silent)
            .map_err(|err| anyhow!(err))?;
        Ok(status)
    } else {
        run_command(command, cwd, env_map, timeout_secs, silent)
    }
}

fn emit_vm_log_entry(
    app: Option<&AppHandle>,
    backend_ctx: &BackendContext,
    phase: &str,
    message: &str,
) {
    let Some(app) = app else {
        return;
    };
    let Some(vm) = &backend_ctx.vm else {
        return;
    };
    backend::emit_vm_log(
        Some(app),
        &vm.repo_path,
        Some(&vm.name),
        Some(vm.provider),
        phase,
        message,
    );
}

fn emit_setup_step_event(
    app: Option<&AppHandle>,
    repo_path: &Path,
    app_id: &str,
    step_index: usize,
    step_name: &str,
    status: &str,
    message: Option<String>,
) {
    let Some(app) = app else {
        return;
    };
    let payload = SetupStepEvent {
        repo_path: repo_path.to_string_lossy().to_string(),
        app_id: app_id.to_string(),
        step_index,
        step_name: step_name.to_string(),
        status: status.to_string(),
        message,
    };
    let _ = app.emit("falck:setup-step", payload);
}

fn run_command_backend_with_vm_logs(
    app: Option<&AppHandle>,
    backend_ctx: &BackendContext,
    phase: &str,
    label: &str,
    command: &str,
    cwd: &Path,
    env_map: &HashMap<String, String>,
    timeout_secs: Option<u32>,
    silent: bool,
) -> Result<ExitStatus> {
    if silent || app.is_none() || backend_ctx.vm.is_none() {
        return run_command_backend(
            backend_ctx,
            command,
            cwd,
            env_map,
            timeout_secs,
            silent,
        );
    }

    let app = app.expect("app handle required");
    let vm = backend_ctx.vm.as_ref().expect("vm required");
    let vm_cwd = backend::vm_app_root(vm, cwd).map_err(|err| anyhow!(err))?;
    let exports = backend::vm_env_exports(env_map);
    let script = format!(
        "{}cd {} && {}",
        exports,
        backend::shell_escape(&vm_cwd),
        command
    );
    let mut cmd = backend::build_vm_command(vm, &script);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    emit_vm_log_entry(
        Some(app),
        backend_ctx,
        phase,
        &format!("[{}] Starting", label),
    );

    let mut child = cmd.spawn().context("Failed to spawn command")?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let app_stdout = app.clone();
    let vm_stdout = vm.clone();
    let label_stdout = label.to_string();
    let phase_stdout = phase.to_string();
    let out_handle = std::thread::spawn(move || {
        if let Some(out) = stdout {
            let reader = BufReader::new(out);
            for line in reader.lines().flatten() {
                let line = line.trim_end();
                if line.is_empty() {
                    continue;
                }
                let message = format!("[{}] {}", label_stdout, line);
                backend::emit_vm_log(
                    Some(&app_stdout),
                    &vm_stdout.repo_path,
                    Some(&vm_stdout.name),
                    Some(vm_stdout.provider),
                    &phase_stdout,
                    &message,
                );
            }
        }
    });

    let app_stderr = app.clone();
    let vm_stderr = vm.clone();
    let label_stderr = label.to_string();
    let phase_stderr = phase.to_string();
    let err_handle = std::thread::spawn(move || {
        if let Some(err) = stderr {
            let reader = BufReader::new(err);
            for line in reader.lines().flatten() {
                let line = line.trim_end();
                if line.is_empty() {
                    continue;
                }
                let message = format!("[{}] ERROR: {}", label_stderr, line);
                backend::emit_vm_log(
                    Some(&app_stderr),
                    &vm_stderr.repo_path,
                    Some(&vm_stderr.name),
                    Some(vm_stderr.provider),
                    &phase_stderr,
                    &message,
                );
            }
        }
    });

    let status = if let Some(timeout) = timeout_secs {
        let start = Instant::now();
        let timeout_duration = Duration::from_secs(timeout as u64);
        loop {
            if let Some(status) = child
                .try_wait()
                .context("Failed to check command status")?
            {
                break status;
            }
            if start.elapsed() > timeout_duration {
                let _ = child.kill();
                let _ = child.wait();
                let _ = out_handle.join();
                let _ = err_handle.join();
                emit_vm_log_entry(
                    Some(app),
                    backend_ctx,
                    phase,
                    &format!("[{}] Timed out after {}s", label, timeout),
                );
                bail!("Command timed out after {} seconds", timeout);
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    } else {
        child.wait().context("Failed to wait for command")?
    };

    let _ = out_handle.join();
    let _ = err_handle.join();

    let exit_code = status
        .code()
        .map(|code| code.to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let outcome = if status.success() {
        "Completed"
    } else {
        "Failed"
    };
    emit_vm_log_entry(
        Some(app),
        backend_ctx,
        phase,
        &format!("[{}] {} (exit {})", label, outcome, exit_code),
    );

    Ok(status)
}

fn run_command_capture_backend(
    backend: &BackendContext,
    command: &str,
    cwd: &Path,
    env_map: &HashMap<String, String>,
    timeout_secs: Option<u32>,
) -> Result<(ExitStatus, String, String)> {
    if let Some(vm) = &backend.vm {
        let vm_cwd = backend::vm_app_root(vm, cwd).map_err(|err| anyhow!(err))?;
        let exports = backend::vm_env_exports(env_map);
        let script = format!(
            "{}cd {} && {}",
            exports,
            backend::shell_escape(&vm_cwd),
            command
        );
        let cmd = backend::build_vm_command(vm, &script);
        let (status, stdout, stderr) = backend::spawn_capture_with_timeout(cmd, timeout_secs)
            .map_err(|err| anyhow!(err))?;
        Ok((status, stdout, stderr))
    } else {
        run_command_capture(command, cwd, env_map, timeout_secs)
    }
}

fn collect_app_ports(app: &Application) -> Vec<u16> {
    let mut ports = Vec::new();
    if let Some(app_ports) = &app.launch.ports {
        ports.extend(app_ports.iter().copied());
    }
    if let Some(access) = &app.launch.access {
        if let Some(port) = access.port {
            ports.push(port);
        }
    }
    ports
}

fn resolve_backend_for_app(
    app_handle: &AppHandle,
    repo_path: &Path,
    app: &Application,
) -> Result<BackendContext, String> {
    if app.launch.container.is_some() {
        Ok(BackendContext::host())
    } else {
        backend::resolve_backend(app_handle, repo_path)
    }
}

fn run_command(
    command: &str,
    cwd: &Path,
    env_map: &HashMap<String, String>,
    timeout_secs: Option<u32>,
    silent: bool,
) -> Result<ExitStatus> {
    let mut cmd = build_shell_command(command);
    cmd.current_dir(cwd).envs(env_map);

    if silent {
        cmd.stdout(Stdio::null()).stderr(Stdio::null());
    } else {
        cmd.stdout(Stdio::inherit()).stderr(Stdio::inherit());
    }

    let mut child = cmd.spawn().context("Failed to spawn command")?;

    if let Some(timeout) = timeout_secs {
        let start = Instant::now();
        let timeout_duration = Duration::from_secs(timeout as u64);
        loop {
            if let Some(status) = child.try_wait()? {
                return Ok(status);
            }
            if start.elapsed() > timeout_duration {
                let _ = child.kill();
                bail!("Command timed out after {} seconds", timeout);
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    let status = child.wait()?;
    Ok(status)
}

fn run_command_capture(
    command: &str,
    cwd: &Path,
    env_map: &HashMap<String, String>,
    timeout_secs: Option<u32>,
) -> Result<(ExitStatus, String, String)> {
    let mut cmd = build_shell_command(command);
    cmd.current_dir(cwd)
        .envs(env_map)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().context("Failed to spawn command")?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let stdout_handle = std::thread::spawn(move || -> Vec<u8> {
        let mut buf = Vec::new();
        if let Some(mut out) = stdout {
            let _ = out.read_to_end(&mut buf);
        }
        buf
    });

    let stderr_handle = std::thread::spawn(move || -> Vec<u8> {
        let mut buf = Vec::new();
        if let Some(mut err) = stderr {
            let _ = err.read_to_end(&mut buf);
        }
        buf
    });

    let status = if let Some(timeout) = timeout_secs {
        let start = Instant::now();
        let timeout_duration = Duration::from_secs(timeout as u64);
        loop {
            if let Some(status) = child.try_wait()? {
                break status;
            }
            if start.elapsed() > timeout_duration {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_handle.join();
                let _ = stderr_handle.join();
                bail!("Command timed out after {} seconds", timeout);
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    } else {
        child.wait()?
    };

    let stdout_bytes = stdout_handle.join().unwrap_or_default();
    let stderr_bytes = stderr_handle.join().unwrap_or_default();

    let stdout = String::from_utf8_lossy(&stdout_bytes).to_string();
    let stderr = String::from_utf8_lossy(&stderr_bytes).to_string();

    Ok((status, stdout, stderr))
}

pub fn is_port_available(port: u16) -> bool {
    let addr = format!("127.0.0.1:{}", port);
    std::net::TcpListener::bind(&addr).is_ok()
}

pub fn kill_app(pid: u32) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        Command::new("taskkill")
            .args(&["/PID", &pid.to_string(), "/F"])
            .output()
            .context("Failed to stop process")?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        Command::new("kill")
            .arg(pid.to_string())
            .output()
            .context("Failed to stop process")?;
    }

    Ok(())
}

fn build_shell_command(command: &str) -> Command {
    if cfg!(target_os = "windows") {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(command);
        cmd
    } else {
        // Use a login shell so GUI builds inherit user PATH and profile settings.
        let shell = resolve_shell_path();
        let mut cmd = Command::new(shell);
        cmd.arg("-l").arg("-c").arg(command);
        cmd
    }
}

fn resolve_shell_path() -> String {
    if let Ok(shell) = env::var("SHELL") {
        if !shell.is_empty() && Path::new(&shell).exists() {
            return shell;
        }
    }

    let fallback = if cfg!(target_os = "macos") {
        "/bin/zsh"
    } else {
        "/bin/bash"
    };

    if Path::new(fallback).exists() {
        fallback.to_string()
    } else {
        "/bin/sh".to_string()
    }
}

fn shell_env_cache() -> &'static Mutex<Option<HashMap<String, String>>> {
    SHELL_ENV_CACHE.get_or_init(|| Mutex::new(None))
}

pub(crate) fn load_shell_env() -> Option<HashMap<String, String>> {
    let cache = shell_env_cache();
    let mut guard = cache.lock().unwrap_or_else(|err| err.into_inner());
    if guard.is_none() {
        *guard = capture_shell_env();
    }
    guard.clone()
}

fn refresh_shell_env_cache() -> Option<HashMap<String, String>> {
    let cache = shell_env_cache();
    let mut guard = cache.lock().unwrap_or_else(|err| err.into_inner());
    *guard = capture_shell_env();
    guard.clone()
}

#[cfg(target_os = "windows")]
fn capture_shell_env() -> Option<HashMap<String, String>> {
    None
}

#[cfg(not(target_os = "windows"))]
fn capture_shell_env() -> Option<HashMap<String, String>> {
    let shell = resolve_shell_path();
    let marker_start = "__FALCK_ENV_BEGIN__";
    let marker_end = "__FALCK_ENV_END__";
    let command = format!(
        "printf '{}\\0'; env -0; printf '{}\\0'",
        marker_start, marker_end
    );

    let output = Command::new(shell)
        .arg("-l")
        .arg("-i")
        .arg("-c")
        .arg(command)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = output.stdout;
    let start_marker = format!("{}\0", marker_start).into_bytes();
    let end_marker = format!("{}\0", marker_end).into_bytes();
    let start = find_subsequence(&stdout, &start_marker)?;
    let env_start = start + start_marker.len();
    let end =
        find_subsequence(&stdout[env_start..], &end_marker).map(|offset| env_start + offset)?;
    let env_bytes = &stdout[env_start..end];
    Some(parse_env_null(env_bytes))
}

fn load_vm_shell_env(vm: &backend::VmContext) -> Option<HashMap<String, String>> {
    let marker_start = "__FALCK_ENV_BEGIN__";
    let marker_end = "__FALCK_ENV_END__";
    let script = format!(
        r#"
marker_start='{start}'
marker_end='{end}'
shell=""
if [ -n "${{SHELL:-}}" ] && command -v "$SHELL" >/dev/null 2>&1; then
  shell="$SHELL"
elif command -v bash >/dev/null 2>&1; then
  shell="$(command -v bash)"
elif command -v zsh >/dev/null 2>&1; then
  shell="$(command -v zsh)"
else
  shell="/bin/sh"
fi
emit_env() {{
  "$shell" "$@" -c "printf '%s\\0' \"$marker_start\"; env -0; printf '%s\\0' \"$marker_end\""
}}
emit_env -l -i && exit 0
emit_env -l && exit 0
emit_env -i && exit 0
emit_env
"#,
        start = marker_start,
        end = marker_end
    );

    let cmd = backend::build_vm_command(vm, &script);
    let (status, stdout, _stderr) =
        backend::spawn_capture_with_timeout(cmd, Some(VM_ENV_TIMEOUT_SECS)).ok()?;
    if !status.success() {
        return None;
    }

    let stdout_bytes = stdout.into_bytes();
    let start_marker = format!("{}\0", marker_start).into_bytes();
    let end_marker = format!("{}\0", marker_end).into_bytes();
    let start = find_subsequence(&stdout_bytes, &start_marker)?;
    let env_start = start + start_marker.len();
    let end =
        find_subsequence(&stdout_bytes[env_start..], &end_marker).map(|offset| env_start + offset)?;
    let env_bytes = &stdout_bytes[env_start..end];
    Some(parse_env_null(env_bytes))
}

fn parse_env_null(bytes: &[u8]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for entry in bytes.split(|b| *b == 0) {
        if entry.is_empty() {
            continue;
        }
        if let Some(pos) = entry.iter().position(|b| *b == b'=') {
            let key = String::from_utf8_lossy(&entry[..pos]).to_string();
            let value = String::from_utf8_lossy(&entry[pos + 1..]).to_string();
            map.insert(key, value);
        }
    }
    map
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

// ============================================================================
// Template Variables
// ============================================================================

struct TemplateContext {
    repo_root: PathBuf,
    app_root: PathBuf,
    os: String,
    arch: String,
    system_user: String,
    system_shell: String,
    env: HashMap<String, String>,
}

impl TemplateContext {
    fn new(repo_root: &Path, app_root: &Path) -> Self {
        let base_env: HashMap<String, String> = env::vars().collect();
        Self::new_with_env(repo_root, app_root, &base_env, None)
    }

    fn new_for_backend(
        repo_root: &Path,
        app_root: &Path,
        base_env: &HashMap<String, String>,
        backend: &BackendContext,
    ) -> Self {
        Self::new_with_env(repo_root, app_root, base_env, Some(backend))
    }

    fn new_with_env(
        repo_root: &Path,
        app_root: &Path,
        base_env: &HashMap<String, String>,
        backend: Option<&BackendContext>,
    ) -> Self {
        let os = match backend.map(|value| value.mode) {
            Some(backend::BackendMode::Virtualized) => "linux".to_string(),
            _ => env::consts::OS.to_string(),
        };
        let arch = match env::consts::ARCH {
            "aarch64" => "arm64".to_string(),
            value => value.to_string(),
        };
        let system_user = base_env
            .get("USER")
            .or_else(|| base_env.get("USERNAME"))
            .cloned()
            .or_else(|| {
                env::var("USER")
                    .or_else(|_| env::var("USERNAME"))
                    .ok()
            })
            .unwrap_or_default();
        let mut system_shell = base_env
            .get("SHELL")
            .or_else(|| base_env.get("ComSpec"))
            .cloned()
            .or_else(|| env::var("SHELL").or_else(|_| env::var("ComSpec")).ok())
            .unwrap_or_default();
        if system_shell.is_empty()
            && matches!(backend.map(|value| value.mode), Some(backend::BackendMode::Virtualized))
        {
            system_shell = "/bin/sh".to_string();
        }

        Self {
            repo_root: repo_root.to_path_buf(),
            app_root: app_root.to_path_buf(),
            os,
            arch,
            system_user,
            system_shell,
            env: base_env.clone(),
        }
    }

    fn resolve(&self, key: &str) -> Result<String> {
        match key {
            "repo_root" => Ok(self.repo_root.to_string_lossy().to_string()),
            "app_root" => Ok(self.app_root.to_string_lossy().to_string()),
            "os" => Ok(self.os.clone()),
            "arch" => Ok(self.arch.clone()),
            "system.user" => Ok(self.system_user.clone()),
            "system.shell" => Ok(self.system_shell.clone()),
            _ => {
                if let Some(rest) = key.strip_prefix("env.") {
                    Ok(self
                        .env
                        .get(rest)
                        .cloned()
                        .unwrap_or_default())
                } else {
                    bail!("Unknown template variable: {}", key)
                }
            }
        }
    }
}

fn resolve_template(input: &str, ctx: &TemplateContext) -> Result<String> {
    let re = Regex::new(r"\{\{\s*([^}]+)\s*\}\}")?;
    let mut result = String::new();
    let mut last_index = 0;

    for cap in re.captures_iter(input) {
        let m = cap.get(0).unwrap();
        result.push_str(&input[last_index..m.start()]);
        let key = cap.get(1).unwrap().as_str().trim();
        let replacement = ctx.resolve(key)?;
        result.push_str(&replacement);
        last_index = m.end();
    }

    result.push_str(&input[last_index..]);
    Ok(result)
}

// ============================================================================
// Conditional Execution (only_if)
// ============================================================================

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Identifier(String),
    String(String),
    Number(f64),
    Eq,
    Ne,
    Gt,
    Lt,
    Ge,
    Le,
    And,
    Or,
    Not,
    Contains,
    LParen,
    RParen,
}

#[derive(Debug, Clone)]
enum Value {
    String(String),
    Number(f64),
    Bool(bool),
}

impl Value {
    fn as_bool(&self) -> bool {
        match self {
            Value::Bool(val) => *val,
            Value::Number(val) => *val != 0.0,
            Value::String(val) => match val.to_lowercase().as_str() {
                "true" => true,
                "false" => false,
                _ => !val.is_empty(),
            },
        }
    }

    fn as_number(&self) -> Option<f64> {
        match self {
            Value::Number(val) => Some(*val),
            Value::String(val) => val.parse::<f64>().ok(),
            Value::Bool(val) => Some(if *val { 1.0 } else { 0.0 }),
        }
    }

    fn as_string(&self) -> String {
        match self {
            Value::String(val) => val.clone(),
            Value::Number(val) => val.to_string(),
            Value::Bool(val) => val.to_string(),
        }
    }
}

fn evaluate_condition(condition: &str, ctx: &TemplateContext) -> Result<bool> {
    if condition.trim().is_empty() {
        return Ok(true);
    }
    let tokens = tokenize(condition)?;
    let mut parser = ConditionParser::new(tokens, ctx);
    let result = parser.parse_expression()?;
    parser.expect_end()?;
    Ok(result)
}

fn tokenize(input: &str) -> Result<Vec<Token>> {
    let bytes = input.as_bytes();
    let mut tokens = Vec::new();
    let mut i = 0;

    while i < bytes.len() {
        let c = bytes[i] as char;
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        if input[i..].starts_with("&&") {
            tokens.push(Token::And);
            i += 2;
            continue;
        }
        if input[i..].starts_with("||") {
            tokens.push(Token::Or);
            i += 2;
            continue;
        }
        if input[i..].starts_with("==") {
            tokens.push(Token::Eq);
            i += 2;
            continue;
        }
        if input[i..].starts_with("!=") {
            tokens.push(Token::Ne);
            i += 2;
            continue;
        }
        if input[i..].starts_with(">=") {
            tokens.push(Token::Ge);
            i += 2;
            continue;
        }
        if input[i..].starts_with("<=") {
            tokens.push(Token::Le);
            i += 2;
            continue;
        }
        if input[i..].starts_with("contains") {
            let next = i + "contains".len();
            if next >= bytes.len()
                || !((bytes[next] as char).is_ascii_alphanumeric() || bytes[next] == b'_')
            {
                tokens.push(Token::Contains);
                i += "contains".len();
                continue;
            }
        }
        match c {
            '(' => {
                tokens.push(Token::LParen);
                i += 1;
            }
            ')' => {
                tokens.push(Token::RParen);
                i += 1;
            }
            '!' => {
                tokens.push(Token::Not);
                i += 1;
            }
            '>' => {
                tokens.push(Token::Gt);
                i += 1;
            }
            '<' => {
                tokens.push(Token::Lt);
                i += 1;
            }
            '\'' | '"' => {
                let quote = c;
                i += 1;
                let mut value = String::new();
                while i < bytes.len() {
                    let ch = bytes[i] as char;
                    if ch == '\\' && i + 1 < bytes.len() {
                        let next_char = bytes[i + 1] as char;
                        value.push(next_char);
                        i += 2;
                        continue;
                    }
                    if ch == quote {
                        i += 1;
                        break;
                    }
                    value.push(ch);
                    i += 1;
                }
                tokens.push(Token::String(value));
            }
            _ => {
                if c.is_ascii_digit() {
                    let start = i;
                    i += 1;
                    while i < bytes.len() {
                        let ch = bytes[i] as char;
                        if ch.is_ascii_digit() || ch == '.' {
                            i += 1;
                        } else {
                            break;
                        }
                    }
                    let slice = &input[start..i];
                    let value = slice.parse::<f64>().context("Invalid number")?;
                    tokens.push(Token::Number(value));
                } else if c.is_ascii_alphabetic() || c == '_' {
                    let start = i;
                    i += 1;
                    while i < bytes.len() {
                        let ch = bytes[i] as char;
                        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '.' {
                            i += 1;
                        } else {
                            break;
                        }
                    }
                    let value = input[start..i].to_string();
                    tokens.push(Token::Identifier(value));
                } else {
                    bail!("Invalid token in condition: {}", c);
                }
            }
        }
    }

    Ok(tokens)
}

struct ConditionParser<'a> {
    tokens: Vec<Token>,
    pos: usize,
    ctx: &'a TemplateContext,
}

impl<'a> ConditionParser<'a> {
    fn new(tokens: Vec<Token>, ctx: &'a TemplateContext) -> Self {
        Self {
            tokens,
            pos: 0,
            ctx,
        }
    }

    fn parse_expression(&mut self) -> Result<bool> {
        self.parse_or()
    }

    fn parse_or(&mut self) -> Result<bool> {
        let mut left = self.parse_and()?;
        while self.matches(&Token::Or) {
            left = left || self.parse_and()?;
        }
        Ok(left)
    }

    fn parse_and(&mut self) -> Result<bool> {
        let mut left = self.parse_not()?;
        while self.matches(&Token::And) {
            left = left && self.parse_not()?;
        }
        Ok(left)
    }

    fn parse_not(&mut self) -> Result<bool> {
        if self.matches(&Token::Not) {
            Ok(!self.parse_not()?)
        } else {
            self.parse_comparison()
        }
    }

    fn parse_comparison(&mut self) -> Result<bool> {
        let left = self.parse_primary()?;
        let op = self.peek().cloned();
        match op {
            Some(Token::Eq)
            | Some(Token::Ne)
            | Some(Token::Gt)
            | Some(Token::Lt)
            | Some(Token::Ge)
            | Some(Token::Le)
            | Some(Token::Contains) => {
                let op_token = self.next().unwrap();
                let right = self.parse_primary()?;
                self.compare_values(left, op_token, right)
            }
            _ => Ok(left.as_bool()),
        }
    }

    fn parse_primary(&mut self) -> Result<Value> {
        match self.next() {
            Some(Token::Identifier(name)) => Ok(self.resolve_identifier(&name)?),
            Some(Token::String(value)) => Ok(Value::String(value)),
            Some(Token::Number(value)) => Ok(Value::Number(value)),
            Some(Token::LParen) => {
                let value = self.parse_expression()?;
                self.expect(Token::RParen)?;
                Ok(Value::Bool(value))
            }
            other => bail!("Unexpected token: {:?}", other),
        }
    }

    fn compare_values(&self, left: Value, op: Token, right: Value) -> Result<bool> {
        match op {
            Token::Eq => Ok(left.as_string() == right.as_string()),
            Token::Ne => Ok(left.as_string() != right.as_string()),
            Token::Contains => Ok(left.as_string().contains(&right.as_string())),
            Token::Gt | Token::Lt | Token::Ge | Token::Le => {
                let left_num = left.as_number().context("Left side is not numeric")?;
                let right_num = right.as_number().context("Right side is not numeric")?;
                Ok(match op {
                    Token::Gt => left_num > right_num,
                    Token::Lt => left_num < right_num,
                    Token::Ge => left_num >= right_num,
                    Token::Le => left_num <= right_num,
                    _ => false,
                })
            }
            _ => bail!("Invalid comparison operator"),
        }
    }

    fn resolve_identifier(&self, name: &str) -> Result<Value> {
        if name.eq_ignore_ascii_case("true") {
            return Ok(Value::Bool(true));
        }
        if name.eq_ignore_ascii_case("false") {
            return Ok(Value::Bool(false));
        }
        Ok(Value::String(self.ctx.resolve(name)?))
    }

    fn matches(&mut self, token: &Token) -> bool {
        if self.peek() == Some(token) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    fn expect(&mut self, token: Token) -> Result<()> {
        if self.matches(&token) {
            Ok(())
        } else {
            bail!("Expected token {:?}", token);
        }
    }

    fn expect_end(&self) -> Result<()> {
        if self.pos < self.tokens.len() {
            bail!("Unexpected tokens remaining in condition");
        }
        Ok(())
    }

    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.pos)
    }

    fn next(&mut self) -> Option<Token> {
        if self.pos >= self.tokens.len() {
            None
        } else {
            let token = self.tokens[self.pos].clone();
            self.pos += 1;
            Some(token)
        }
    }
}

// ============================================================================
// Tauri Commands
// ============================================================================

#[tauri::command]
pub async fn load_falck_config(repo_path: String) -> Result<FalckConfig, String> {
    run_blocking(move || {
        let path = Path::new(&repo_path);
        load_config(path).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn get_app_secrets_for_config(
    repo_path: String,
    app_id: String,
) -> Result<Vec<Secret>, String> {
    run_blocking(move || {
        let path = Path::new(&repo_path);
        let config = load_config(path).map_err(|e| e.to_string())?;
        let app = config
            .applications
            .iter()
            .find(|app| app.id == app_id)
            .ok_or_else(|| "Application not found".to_string())?;

        Ok(get_app_secrets(app))
    })
    .await
}

#[tauri::command]
pub async fn set_app_secret(name: String, value: String) -> Result<(), String> {
    set_secret(name, value);
    Ok(())
}

#[tauri::command]
pub async fn check_secrets_satisfied(repo_path: String, app_id: String) -> Result<bool, String> {
    run_blocking(move || {
        let path = Path::new(&repo_path);
        let config = load_config(path).map_err(|e| e.to_string())?;
        let app = config
            .applications
            .iter()
            .find(|app| app.id == app_id)
            .ok_or_else(|| "Application not found".to_string())?;

        Ok(check_app_secrets_satisfied(app))
    })
    .await
}

#[tauri::command]
pub async fn check_falck_setup_steps(
    app: AppHandle,
    repo_path: String,
    app_id: String,
) -> Result<Vec<SetupStepCheckResult>, String> {
    run_blocking(move || {
        let path = Path::new(&repo_path);
        let config = load_config(path).map_err(|e| e.to_string())?;
        let app_config = config
            .applications
            .iter()
            .find(|app| app.id == app_id)
            .ok_or_else(|| "Application not found".to_string())?;
        let backend = resolve_backend_for_app(&app, path, app_config)?;

        check_setup_steps(path, &config, app_config, &backend).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn run_falck_setup(
    app: AppHandle,
    repo_path: String,
    app_id: String,
) -> Result<String, String> {
    run_blocking(move || {
        let path = Path::new(&repo_path);
        let config = load_config(path).map_err(|e| e.to_string())?;
        let app_config = config
            .applications
            .iter()
            .find(|app| app.id == app_id)
            .ok_or_else(|| "Application not found".to_string())?;
        let backend = resolve_backend_for_app(&app, path, app_config)?;

        run_setup(path, &config, app_config, &backend, Some(&app))
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn run_falck_setup_step(
    app: AppHandle,
    repo_path: String,
    app_id: String,
    step_index: usize,
) -> Result<String, String> {
    run_blocking(move || {
        let path = Path::new(&repo_path);
        let config = load_config(path).map_err(|e| e.to_string())?;
        let app_config = config
            .applications
            .iter()
            .find(|app| app.id == app_id)
            .ok_or_else(|| "Application not found".to_string())?;
        let backend = resolve_backend_for_app(&app, path, app_config)?;

        run_setup_step(path, &config, app_config, step_index, &backend, Some(&app))
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn run_falck_setup_step_teardown(
    app: AppHandle,
    repo_path: String,
    app_id: String,
    step_index: usize,
) -> Result<String, String> {
    run_blocking(move || {
        let path = Path::new(&repo_path);
        let config = load_config(path).map_err(|e| e.to_string())?;
        let app_config = config
            .applications
            .iter()
            .find(|app| app.id == app_id)
            .ok_or_else(|| "Application not found".to_string())?;
        let backend = resolve_backend_for_app(&app, path, app_config)?;

        run_setup_step_teardown(path, &config, app_config, step_index, &backend)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn launch_falck_app(
    app: AppHandle,
    state: State<'_, FalckProcessState>,
    repo_path: String,
    app_id: String,
) -> Result<LaunchResult, String> {
    #[derive(Debug)]
    enum LaunchOutcome {
        Process(BackendProcess),
        Container(crate::containers::ContainerHandle),
    }

    let app_handle = app.clone();
    let outcome = run_blocking(move || {
        let path = Path::new(&repo_path);
        let config = load_config(path).map_err(|e| e.to_string())?;
        let app_config = config
            .applications
            .iter()
            .find(|app| app.id == app_id)
            .ok_or_else(|| "Application not found".to_string())?;
        if app_config.launch.container.is_some() {
            let spec =
                build_container_launch_spec(path, &config, app_config).map_err(|e| e.to_string())?;
            let handle = crate::containers::launch_container(&app_handle, spec)
                .map_err(|e| e.to_string())?;
            Ok(LaunchOutcome::Container(handle))
        } else {
            let backend_ctx = resolve_backend_for_app(&app_handle, path, app_config)?;
            if let Some(vm) = &backend_ctx.vm {
                let ports = collect_app_ports(app_config);
                backend::ensure_vm_port_forwards(Some(&app_handle), vm, &ports)
                    .map_err(|e| e.to_string())?;
            }
            let process = launch_app(path, &config, app_config, &backend_ctx)
                .map_err(|e| e.to_string())?;
            Ok(LaunchOutcome::Process(process))
        }
    })
    .await?;

    match outcome {
        LaunchOutcome::Process(process) => {
            let pid = backend_process_pid(&process);
            register_running_app(&state, RunningFalckApp { process });
            Ok(LaunchResult {
                kind: "process".to_string(),
                pid: Some(pid),
                container: None,
            })
        }
        LaunchOutcome::Container(handle) => Ok(LaunchResult {
            kind: "container".to_string(),
            pid: None,
            container: Some(handle),
        }),
    }
}

#[tauri::command]
pub async fn run_falck_cleanup(
    app: AppHandle,
    repo_path: String,
    app_id: String,
) -> Result<String, String> {
    run_blocking(move || {
        let path = Path::new(&repo_path);
        let config = load_config(path).map_err(|e| e.to_string())?;
        let app_config = config
            .applications
            .iter()
            .find(|app| app.id == app_id)
            .ok_or_else(|| "Application not found".to_string())?;
        let backend = resolve_backend_for_app(&app, path, app_config)?;

        run_cleanup(path, &config, app_config, &backend).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn upload_falck_assets(
    repo_path: String,
    app_id: String,
    target_subdirectory: Option<String>,
    files: Vec<AssetUploadFile>,
) -> Result<Vec<String>, String> {
    run_blocking(move || {
        let path = Path::new(&repo_path);
        let config = load_config(path).map_err(|e| e.to_string())?;
        let app = config
            .applications
            .iter()
            .find(|app| app.id == app_id)
            .ok_or_else(|| "Application not found".to_string())?;

        upload_assets(path, app, target_subdirectory, files).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn kill_falck_app(state: State<'_, FalckProcessState>, pid: u32) -> Result<(), String> {
    let handle = unregister_running_app(&state, pid);
    run_blocking(move || {
        if let Some(app) = handle {
            kill_backend_process(app.process).map_err(|e| e.to_string())
        } else {
            kill_app(pid).map_err(|e| e.to_string())
        }
    })
    .await
}

#[tauri::command]
pub async fn check_port_available(port: u16) -> bool {
    run_blocking_value(move || is_port_available(port))
        .await
        .unwrap_or(false)
}

#[tauri::command]
pub async fn open_browser_to_url(url: String) -> Result<(), String> {
    run_blocking(move || open::that(&url).map_err(|e| e.to_string())).await
}

#[tauri::command]
pub async fn clear_all_secrets() -> Result<(), String> {
    clear_secrets();
    Ok(())
}
