use anyhow::{bail, Context, Result};
use lazy_static::lazy_static;
use regex::Regex;
use semver::Version;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

lazy_static! {
    static ref SECRETS_STORE: Mutex<HashMap<String, String>> = Mutex::new(HashMap::new());
}

static SHELL_ENV_CACHE: OnceLock<Option<HashMap<String, String>>> = OnceLock::new();

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
    pub prerequisites: Option<Vec<Prerequisite>>,
    pub secrets: Option<Vec<Secret>>,
    pub setup: Option<SetupConfig>,
    pub launch: LaunchConfig,
    pub cleanup: Option<CleanupConfig>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Prerequisite {
    #[serde(rename = "type")]
    pub prereq_type: String,
    pub name: String,
    pub command: String,
    pub version: Option<String>,
    pub install_url: Option<String>,
    pub install: Option<PrerequisiteInstall>,
    pub optional: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(untagged)]
pub enum PrerequisiteInstallInstructions {
    Text(String),
    List(Vec<String>),
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PrerequisiteInstallOption {
    pub name: String,
    pub command: String,
    pub description: Option<String>,
    pub timeout: Option<u32>,
    pub silent: Option<bool>,
    pub only_if: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PrerequisiteInstall {
    pub instructions: Option<PrerequisiteInstallInstructions>,
    pub options: Option<Vec<PrerequisiteInstallOption>>,
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
    pub check: Option<SetupCheck>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SetupStep {
    pub name: String,
    pub command: String,
    pub description: Option<String>,
    pub timeout: Option<u32>,
    pub silent: Option<bool>,
    pub optional: Option<bool>,
    pub only_if: Option<String>,
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
pub struct SetupCheckResult {
    pub configured: bool,
    pub complete: bool,
    pub message: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LaunchConfig {
    pub command: String,
    pub description: Option<String>,
    pub timeout: Option<u32>,
    pub access: Option<AccessConfig>,
    pub env: Option<HashMap<String, String>>,
    pub ports: Option<Vec<u16>>,
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
pub struct PrerequisiteCheckResult {
    pub name: String,
    pub command: String,
    pub installed: bool,
    pub required_version: Option<String>,
    pub current_version: Option<String>,
    pub install_url: Option<String>,
    pub optional: bool,
}

// ============================================================================
// Config Loading
// ============================================================================

pub fn load_config(repo_path: &Path) -> Result<FalckConfig> {
    let config_path = repo_path.join(".falck").join("config.yaml");
    if !config_path.exists() {
        bail!("No .falck/config.yaml found in repository");
    }

    let content = std::fs::read_to_string(&config_path)
        .context("Failed to read config.yaml")?;

    let config: FalckConfig = serde_yaml::from_str(&content)
        .context("Failed to parse config.yaml")?;

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
// Prerequisite Checks
// ============================================================================

pub fn check_prerequisites(
    repo_path: &Path,
    app: &Application,
    prereq: &Prerequisite,
    env_map: &HashMap<String, String>,
) -> Result<PrerequisiteCheckResult> {
    let app_root = get_app_root(repo_path, app);
    let ctx = TemplateContext::new(repo_path, &app_root);
    let command = resolve_template(&prereq.command, &ctx)?;

    let output = build_shell_command(&command)
        .current_dir(&app_root)
        .envs(env_map)
        .output()
        .context("Failed to run prerequisite command")?;

    let mut installed = output.status.success();
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let current_version = if installed {
        parse_version(format!("{}\n{}", stdout, stderr).as_str())
    } else {
        None
    };

    if let Some(required) = &prereq.version {
        let required_version = Version::parse(required)
            .context("Invalid semver version in prerequisite")?;
        if let Some(ref current) = current_version {
            let parsed_current = Version::parse(current)
                .context("Failed to parse installed version")?;
            if parsed_current < required_version {
                installed = false;
            }
        } else {
            installed = false;
        }
    }

    Ok(PrerequisiteCheckResult {
        name: prereq.name.clone(),
        command,
        installed,
        required_version: prereq.version.clone(),
        current_version,
        install_url: prereq.install_url.clone(),
        optional: prereq.optional.unwrap_or(false),
    })
}

pub fn check_app_prerequisites(
    repo_path: &Path,
    config: &FalckConfig,
    app: &Application,
) -> Result<Vec<PrerequisiteCheckResult>> {
    let mut results = Vec::new();
    let app_root = get_app_root(repo_path, app);
    let ctx = TemplateContext::new(repo_path, &app_root);
    let env_map = build_env_map(config, app, &ctx)?;
    if let Some(prereqs) = &app.prerequisites {
        for prereq in prereqs {
            results.push(check_prerequisites(repo_path, app, prereq, &env_map)?);
        }
    }
    Ok(results)
}

pub fn run_prerequisite_install(
    repo_path: &Path,
    config: &FalckConfig,
    app: &Application,
    prereq_index: usize,
    option_index: usize,
) -> Result<String> {
    let prereqs = app
        .prerequisites
        .as_ref()
        .context("No prerequisites configured for this application")?;
    let prereq = prereqs
        .get(prereq_index)
        .context("Prerequisite not found")?;
    let install = prereq
        .install
        .as_ref()
        .context("No install options configured for this prerequisite")?;
    let options = install
        .options
        .as_ref()
        .context("No install options configured for this prerequisite")?;
    let option = options
        .get(option_index)
        .context("Install option not found")?;

    let app_root = get_app_root(repo_path, app);
    let ctx = TemplateContext::new(repo_path, &app_root);
    let env_map = build_env_map(config, app, &ctx)?;

    if let Some(condition) = &option.only_if {
        if !evaluate_condition(condition, &ctx)? {
            return Ok("Install option skipped for this environment.".to_string());
        }
    }

    let command = resolve_template(&option.command, &ctx)?;
    let timeout = option.timeout.unwrap_or(300);
    let silent = option.silent.unwrap_or(false);
    let status = run_command(&command, &app_root, &env_map, Some(timeout), silent)?;

    if !status.success() {
        bail!("Prerequisite install option '{}' failed", option.name);
    }

    Ok(format!("Ran install option '{}'.", option.name))
}

fn parse_version(output: &str) -> Option<String> {
    let re = Regex::new(r"v?(\d+\.\d+\.\d+)").ok()?;
    re.captures(output)
        .and_then(|cap| cap.get(1).map(|m| m.as_str().to_string()))
}

// ============================================================================
// Setup / Launch / Cleanup
// ============================================================================

pub fn run_setup(
    repo_path: &Path,
    config: &FalckConfig,
    app: &Application,
) -> Result<String> {
    if !check_app_secrets_satisfied(app) {
        bail!("Required secrets not configured for this application");
    }

    let app_root = get_app_root(repo_path, app);
    let ctx = TemplateContext::new(repo_path, &app_root);
    let env_map = build_env_map(config, app, &ctx)?;

    if let Some(setup) = &app.setup {
        if let Some(steps) = &setup.steps {
            for step in steps {
                if let Some(condition) = &step.only_if {
                    if !evaluate_condition(condition, &ctx)? {
                        continue;
                    }
                }

                let command = resolve_template(&step.command, &ctx)?;
                let timeout = step.timeout.unwrap_or(300);
                let silent = step.silent.unwrap_or(false);
                let status = run_command(
                    &command,
                    &app_root,
                    &env_map,
                    Some(timeout),
                    silent,
                )?;

                if !status.success() {
                    if step.optional.unwrap_or(false) {
                        continue;
                    }
                    bail!("Setup step '{}' failed", step.name);
                }
            }
        }
    }

    Ok("Setup completed successfully".to_string())
}

pub fn check_setup_status(
    repo_path: &Path,
    config: &FalckConfig,
    app: &Application,
) -> Result<SetupCheckResult> {
    let Some(setup) = &app.setup else {
        return Ok(SetupCheckResult {
            configured: false,
            complete: true,
            message: None,
        });
    };

    let Some(check) = &setup.check else {
        return Ok(SetupCheckResult {
            configured: false,
            complete: true,
            message: None,
        });
    };

    let app_root = get_app_root(repo_path, app);
    let ctx = TemplateContext::new(repo_path, &app_root);
    let env_map = build_env_map(config, app, &ctx)?;

    if let Some(condition) = &check.only_if {
        if !evaluate_condition(condition, &ctx)? {
            return Ok(SetupCheckResult {
                configured: true,
                complete: true,
                message: Some("Setup check skipped for this environment.".to_string()),
            });
        }
    }

    let expectation_count = check.expect.is_some() as u8
        + check.expect_contains.is_some() as u8
        + check.expect_regex.is_some() as u8;
    if expectation_count > 1 {
        return Ok(SetupCheckResult {
            configured: true,
            complete: false,
            message: Some(
                "Setup check has multiple expectations. Use only one of expect, expect_contains, or expect_regex."
                    .to_string(),
            ),
        });
    }

    let command = resolve_template(&check.command, &ctx)?;
    let timeout = check.timeout.unwrap_or(30);
    let ignore_exit = check.ignore_exit.unwrap_or(false);
    let trim_output = check.trim.unwrap_or(true);
    let output_mode = check.output.clone().unwrap_or_else(|| "stdout".to_string());

    match run_command_capture(&command, &app_root, &env_map, Some(timeout)) {
        Ok((status, stdout, stderr)) => {
            if !status.success() && !ignore_exit {
                return Ok(SetupCheckResult {
                    configured: true,
                    complete: false,
                    message: Some("Setup check command failed.".to_string()),
                });
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
                        return Ok(SetupCheckResult {
                            configured: true,
                            complete: false,
                            message: Some(format!("Invalid setup check regex: {}", err)),
                        });
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

            Ok(SetupCheckResult {
                configured: true,
                complete,
                message,
            })
        }
        Err(err) => Ok(SetupCheckResult {
            configured: true,
            complete: false,
            message: Some(err.to_string()),
        }),
    }
}

pub fn launch_app(
    repo_path: &Path,
    config: &FalckConfig,
    app: &Application,
) -> Result<u32> {
    if !check_app_secrets_satisfied(app) {
        bail!("Required secrets not configured for this application");
    }

    let app_root = get_app_root(repo_path, app);
    let ctx = TemplateContext::new(repo_path, &app_root);
    let env_map = build_env_map(config, app, &ctx)?;
    let command = resolve_template(&app.launch.command, &ctx)?;

    let mut cmd = build_shell_command(&command);
    cmd.current_dir(&app_root)
        .envs(&env_map)
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let child = cmd.spawn().context("Failed to spawn application process")?;
    Ok(child.id())
}

pub fn run_cleanup(
    repo_path: &Path,
    config: &FalckConfig,
    app: &Application,
) -> Result<String> {
    let app_root = get_app_root(repo_path, app);
    let ctx = TemplateContext::new(repo_path, &app_root);
    let env_map = build_env_map(config, app, &ctx)?;

    if let Some(cleanup) = &app.cleanup {
        if let Some(steps) = &cleanup.steps {
            for step in steps {
                if let Some(condition) = &step.only_if {
                    if !evaluate_condition(condition, &ctx)? {
                        continue;
                    }
                }

                let command = resolve_template(&step.command, &ctx)?;
                let timeout = step.timeout.unwrap_or(30);
                let status = run_command(&command, &app_root, &env_map, Some(timeout), true)?;
                if !status.success() {
                    bail!("Cleanup step '{}' failed", step.name);
                }
            }
        }
    }

    Ok("Cleanup completed successfully".to_string())
}

fn build_env_map(
    config: &FalckConfig,
    app: &Application,
    ctx: &TemplateContext,
) -> Result<HashMap<String, String>> {
    let mut env_map: HashMap<String, String> = env::vars().collect();
    if !cfg!(debug_assertions) {
        if let Some(shell_env) = load_shell_env() {
            for (key, value) in shell_env {
                if key == "PATH" {
                    env_map.insert(key, value);
                } else {
                    env_map.entry(key).or_insert(value);
                }
            }
        }
    }

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

fn load_shell_env() -> Option<HashMap<String, String>> {
    SHELL_ENV_CACHE
        .get_or_init(capture_shell_env)
        .clone()
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
    let end = find_subsequence(&stdout[env_start..], &end_marker)
        .map(|offset| env_start + offset)?;
    let env_bytes = &stdout[env_start..end];
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
}

impl TemplateContext {
    fn new(repo_root: &Path, app_root: &Path) -> Self {
        Self {
            repo_root: repo_root.to_path_buf(),
            app_root: app_root.to_path_buf(),
            os: env::consts::OS.to_string(),
            arch: match env::consts::ARCH {
                "aarch64" => "arm64".to_string(),
                value => value.to_string(),
            },
            system_user: env::var("USER")
                .or_else(|_| env::var("USERNAME"))
                .unwrap_or_default(),
            system_shell: env::var("SHELL")
                .or_else(|_| env::var("ComSpec"))
                .unwrap_or_default(),
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
                    Ok(env::var(rest).unwrap_or_default())
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
        Self { tokens, pos: 0, ctx }
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
    let path = Path::new(&repo_path);
    load_config(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn check_falck_prerequisites(
    repo_path: String,
    app_id: String,
) -> Result<Vec<PrerequisiteCheckResult>, String> {
    let path = Path::new(&repo_path);
    let config = load_config(path).map_err(|e| e.to_string())?;
    let app = config
        .applications
        .iter()
        .find(|app| app.id == app_id)
        .ok_or_else(|| "Application not found".to_string())?;

    check_app_prerequisites(path, &config, app).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn run_falck_prerequisite_install(
    repo_path: String,
    app_id: String,
    prereq_index: usize,
    option_index: usize,
) -> Result<String, String> {
    let path = Path::new(&repo_path);
    let config = load_config(path).map_err(|e| e.to_string())?;
    let app = config
        .applications
        .iter()
        .find(|app| app.id == app_id)
        .ok_or_else(|| "Application not found".to_string())?;

    run_prerequisite_install(path, &config, app, prereq_index, option_index)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_app_secrets_for_config(
    repo_path: String,
    app_id: String,
) -> Result<Vec<Secret>, String> {
    let path = Path::new(&repo_path);
    let config = load_config(path).map_err(|e| e.to_string())?;
    let app = config
        .applications
        .iter()
        .find(|app| app.id == app_id)
        .ok_or_else(|| "Application not found".to_string())?;

    Ok(get_app_secrets(app))
}

#[tauri::command]
pub async fn set_app_secret(name: String, value: String) -> Result<(), String> {
    set_secret(name, value);
    Ok(())
}

#[tauri::command]
pub async fn check_secrets_satisfied(
    repo_path: String,
    app_id: String,
) -> Result<bool, String> {
    let path = Path::new(&repo_path);
    let config = load_config(path).map_err(|e| e.to_string())?;
    let app = config
        .applications
        .iter()
        .find(|app| app.id == app_id)
        .ok_or_else(|| "Application not found".to_string())?;

    Ok(check_app_secrets_satisfied(app))
}

#[tauri::command]
pub async fn check_falck_setup(
    repo_path: String,
    app_id: String,
) -> Result<SetupCheckResult, String> {
    let path = Path::new(&repo_path);
    let config = load_config(path).map_err(|e| e.to_string())?;
    let app = config
        .applications
        .iter()
        .find(|app| app.id == app_id)
        .ok_or_else(|| "Application not found".to_string())?;

    check_setup_status(path, &config, app).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn run_falck_setup(repo_path: String, app_id: String) -> Result<String, String> {
    let path = Path::new(&repo_path);
    let config = load_config(path).map_err(|e| e.to_string())?;
    let app = config
        .applications
        .iter()
        .find(|app| app.id == app_id)
        .ok_or_else(|| "Application not found".to_string())?;

    run_setup(path, &config, app).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn launch_falck_app(repo_path: String, app_id: String) -> Result<u32, String> {
    let path = Path::new(&repo_path);
    let config = load_config(path).map_err(|e| e.to_string())?;
    let app = config
        .applications
        .iter()
        .find(|app| app.id == app_id)
        .ok_or_else(|| "Application not found".to_string())?;

    launch_app(path, &config, app).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn run_falck_cleanup(repo_path: String, app_id: String) -> Result<String, String> {
    let path = Path::new(&repo_path);
    let config = load_config(path).map_err(|e| e.to_string())?;
    let app = config
        .applications
        .iter()
        .find(|app| app.id == app_id)
        .ok_or_else(|| "Application not found".to_string())?;

    run_cleanup(path, &config, app).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn kill_falck_app(pid: u32) -> Result<(), String> {
    kill_app(pid).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn check_port_available(port: u16) -> bool {
    is_port_available(port)
}

#[tauri::command]
pub async fn open_browser_to_url(url: String) -> Result<(), String> {
    open::that(&url).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn clear_all_secrets() -> Result<(), String> {
    clear_secrets();
    Ok(())
}
