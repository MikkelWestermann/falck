use crate::{git, github};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Emitter, Manager, State};

const ASTRO_TEMPLATE: &str = "MikkelWestermann/falck-astro";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAstroProjectRequest {
    pub project_name: String,
    pub local_path: String,
    pub repo_mode: String,
    pub repo_name: Option<String>,
    pub repo_full_name: Option<String>,
    pub repo_ssh_url: Option<String>,
    pub repo_visibility: Option<String>,
    pub description: Option<String>,
    pub ssh_key_path: String,
    pub prompt_mode: Option<String>,
    pub install_dependencies: Option<bool>,
    pub initialize_git: Option<bool>,
    pub skip_houston: Option<bool>,
    pub integrations: Option<String>,
    pub astro_ref: Option<String>,
    pub progress_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAstroProjectResult {
    pub path: String,
    pub repo_name: String,
    pub repo_full_name: String,
    pub repo_ssh_url: String,
    pub branch: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CreateProgressEvent {
    pub progress_id: Option<String>,
    pub message: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone)]
struct AstroCreateOptions {
    prompt_mode: String,
    install_dependencies: bool,
    initialize_git: bool,
    skip_houston: bool,
    integrations: Option<String>,
    astro_ref: Option<String>,
}

#[tauri::command]
pub async fn create_astro_project(
    app: AppHandle,
    client: State<'_, Client>,
    input: CreateAstroProjectRequest,
) -> Result<CreateAstroProjectResult, String> {
    let progress_id = input.progress_id.clone();

    emit_progress(
        &app,
        &progress_id,
        "Preparing project folder",
        Some(input.local_path.clone()),
    );
    let local_path = PathBuf::from(&input.local_path);
    if local_path.exists() {
        return Err("Destination folder already exists.".to_string());
    }

    let parent_dir = local_path
        .parent()
        .ok_or_else(|| "Invalid project path.".to_string())?;
    std::fs::create_dir_all(parent_dir).map_err(|e| e.to_string())?;

    emit_progress(&app, &progress_id, "Checking Bun installation", None);
    let bun_path = ensure_bun_installed(&app, &progress_id)?;
    let project_dir = local_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Project folder name is invalid.".to_string())?;
    let options = build_astro_options(&input);
    let bun_args = build_bun_create_args(project_dir, &options);
    emit_progress(
        &app,
        &progress_id,
        "Scaffolding Astro template",
        Some(format!("bun {}", bun_args.join(" "))),
    );
    run_bun_create(&bun_path, parent_dir, &bun_args)?;

    emit_progress(&app, &progress_id, "Initializing Git repository", None);
    if git::open_repository(&input.local_path).is_err() {
        git::init_repository(&input.local_path).map_err(|e| e.to_string())?;
    }

    emit_progress(&app, &progress_id, "Staging files", None);
    git::stage_all(&input.local_path).map_err(|e| e.to_string())?;
    let has_commits = git::has_commits(&input.local_path).map_err(|e| e.to_string())?;
    let repo_info = git::get_repository_info(&input.local_path).map_err(|e| e.to_string())?;
    if repo_info.is_dirty || !has_commits {
        let name = input.project_name.trim();
        let message = if name.is_empty() {
            "Initial commit".to_string()
        } else {
            format!("Initial commit: {}", name)
        };
        emit_progress(&app, &progress_id, "Creating initial commit", Some(message.clone()));
        git::create_commit(&input.local_path, &message, "", "").map_err(|e| e.to_string())?;
    }

    emit_progress(&app, &progress_id, "Ensuring main branch", None);
    let branch = git::ensure_main_branch(&input.local_path).map_err(|e| e.to_string())?;

    let (repo_name, repo_full_name, repo_ssh_url) =
        resolve_repo_destination(&app, &client, &input, &progress_id).await?;

    emit_progress(
        &app,
        &progress_id,
        "Configuring Git remote",
        Some(format!("origin -> {}", repo_full_name)),
    );
    git::add_or_update_remote(&input.local_path, "origin", &repo_ssh_url)
        .map_err(|e| e.to_string())?;
    emit_progress(
        &app,
        &progress_id,
        "Pushing to GitHub",
        Some(format!("origin/{}", branch)),
    );
    if let Err(err) = git::push_to_remote(
        &input.local_path,
        "origin",
        &branch,
        &input.ssh_key_path,
    ) {
        let message = err.to_string();
        let lower = message.to_lowercase();
        if lower.contains("auth") || lower.contains("authentication") {
            return Err(format!(
                "Git push failed due to SSH authentication. Ensure your SSH key is added to GitHub and selected in Falck. Details: {}",
                message
            ));
        }
        return Err(message);
    }

    emit_progress(&app, &progress_id, "Finalizing project", None);

    Ok(CreateAstroProjectResult {
        path: input.local_path,
        repo_name,
        repo_full_name,
        repo_ssh_url,
        branch,
    })
}

async fn resolve_repo_destination(
    app: &AppHandle,
    client: &Client,
    input: &CreateAstroProjectRequest,
    progress_id: &Option<String>,
) -> Result<(String, String, String), String> {
    if input.repo_mode == "existing" {
        let repo_full_name = input
            .repo_full_name
            .clone()
            .ok_or_else(|| "GitHub repository is required.".to_string())?;
        let repo_ssh_url = input
            .repo_ssh_url
            .clone()
            .ok_or_else(|| "GitHub SSH URL is required.".to_string())?;
        let repo_name = repo_full_name
            .split('/')
            .last()
            .unwrap_or(&repo_full_name)
            .to_string();
        emit_progress(
            app,
            progress_id,
            "Using existing GitHub repository",
            Some(repo_full_name.clone()),
        );
        return Ok((repo_name, repo_full_name, repo_ssh_url));
    }

    let repo_name = input
        .repo_name
        .clone()
        .ok_or_else(|| "Repository name is required.".to_string())?;
    if repo_name.trim().is_empty() {
        return Err("Repository name is required.".to_string());
    }
    let private = input
        .repo_visibility
        .as_deref()
        .map(|value| value != "public")
        .unwrap_or(true);
    let description = input.description.clone().filter(|text| !text.trim().is_empty());

    emit_progress(
        app,
        progress_id,
        "Creating GitHub repository",
        Some(repo_name.trim().to_string()),
    );
    let repo = github::github_create_repo(
        app.clone(),
        client,
        repo_name.trim().to_string(),
        description,
        private,
    )
    .await?;

    Ok((repo.name, repo.full_name, repo.ssh_url))
}

fn build_astro_options(input: &CreateAstroProjectRequest) -> AstroCreateOptions {
    let prompt_mode = match input.prompt_mode.as_deref() {
        Some("no") => "no",
        _ => "yes",
    };

    AstroCreateOptions {
        prompt_mode: prompt_mode.to_string(),
        install_dependencies: input.install_dependencies.unwrap_or(true),
        initialize_git: input.initialize_git.unwrap_or(false),
        skip_houston: input.skip_houston.unwrap_or(true),
        integrations: input.integrations.clone(),
        astro_ref: input.astro_ref.clone(),
    }
}

fn build_bun_create_args(project_dir: &str, options: &AstroCreateOptions) -> Vec<String> {
    let mut args = vec![
        "create".to_string(),
        "astro@latest".to_string(),
        project_dir.to_string(),
        "--".to_string(),
        "--template".to_string(),
        ASTRO_TEMPLATE.to_string(),
    ];

    match options.prompt_mode.as_str() {
        "no" => args.push("--no".to_string()),
        _ => args.push("--yes".to_string()),
    }

    if options.install_dependencies {
        args.push("--install".to_string());
    } else {
        args.push("--no-install".to_string());
    }

    if options.initialize_git {
        args.push("--git".to_string());
    } else {
        args.push("--no-git".to_string());
    }

    if options.skip_houston {
        args.push("--skip-houston".to_string());
    }

    if let Some(integrations) = options
        .integrations
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        args.push("--add".to_string());
        args.push(integrations.to_string());
    }

    if let Some(astro_ref) = options
        .astro_ref
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        args.push("--ref".to_string());
        args.push(astro_ref.to_string());
    }

    args
}

fn ensure_bun_installed(
    app: &AppHandle,
    progress_id: &Option<String>,
) -> Result<PathBuf, String> {
    if let Some(path) = resolve_bun_path(app) {
        return Ok(path);
    }
    emit_progress(app, progress_id, "Installing Bun", None);
    install_bun()?;
    resolve_bun_path(app).ok_or_else(|| {
        "Bun installed but was not found. Add ~/.bun/bin to your PATH.".to_string()
    })
}

fn resolve_bun_path(app: &AppHandle) -> Option<PathBuf> {
    if command_exists("bun") {
        return Some(PathBuf::from("bun"));
    }

    if let Ok(bun_install) = std::env::var("BUN_INSTALL") {
        let candidate = PathBuf::from(bun_install)
            .join("bin")
            .join(bun_binary_name());
        if candidate.exists() {
            return Some(candidate);
        }
    }

    if let Ok(home) = app.path().home_dir() {
        let candidate = home.join(".bun").join("bin").join(bun_binary_name());
        if candidate.exists() {
            return Some(candidate);
        }
    }

    None
}

fn bun_binary_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "bun.exe"
    } else {
        "bun"
    }
}

fn install_bun() -> Result<(), String> {
    let status = if cfg!(target_os = "windows") {
        Command::new("powershell")
            .arg("-c")
            .arg("irm bun.sh/install.ps1|iex")
            .status()
            .map_err(|e| e.to_string())?
    } else {
        Command::new("bash")
            .arg("-lc")
            .arg("curl -fsSL https://bun.com/install | bash")
            .status()
            .map_err(|e| e.to_string())?
    };

    if status.success() {
        Ok(())
    } else {
        Err("Bun installation failed.".to_string())
    }
}

fn run_bun_create(bun_path: &Path, parent_dir: &Path, args: &[String]) -> Result<(), String> {
    let mut command = Command::new(bun_path);
    command.current_dir(parent_dir);
    for arg in args {
        command.arg(arg);
    }
    let output = command
        .output()
        .map_err(|e| format!("Failed to run bun create: {}", e))?;

    if output.status.success() {
        return Ok(());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let details = [stdout.trim(), stderr.trim()]
        .into_iter()
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if details.is_empty() {
        Err("Bun create failed.".to_string())
    } else {
        Err(format!("Bun create failed: {}", details))
    }
}

fn command_exists(command: &str) -> bool {
    #[cfg(target_os = "windows")]
    let output = Command::new("where").arg(command).output();

    #[cfg(not(target_os = "windows"))]
    let output = Command::new("which").arg(command).output();

    output.map(|result| result.status.success()).unwrap_or(false)
}

fn emit_progress(
    app: &AppHandle,
    progress_id: &Option<String>,
    message: &str,
    detail: Option<String>,
) {
    let _ = app.emit(
        "create-project-progress",
        CreateProgressEvent {
            progress_id: progress_id.clone(),
            message: message.to_string(),
            detail,
        },
    );
}
