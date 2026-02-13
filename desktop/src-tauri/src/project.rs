use crate::{git, github, opencode};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::{Component, Path, PathBuf};
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
    pub monorepo_enabled: Option<bool>,
    pub monorepo_root: Option<String>,
    pub monorepo_parent_dir: Option<String>,
    pub monorepo_install_command: Option<String>,
    pub progress_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAstroProjectResult {
    pub path: String,
    pub repo_name: Option<String>,
    pub repo_full_name: Option<String>,
    pub repo_ssh_url: Option<String>,
    pub branch: Option<String>,
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
    opencode_state: State<'_, opencode::OpencodeState>,
    input: CreateAstroProjectRequest,
) -> Result<CreateAstroProjectResult, String> {
    let progress_id = input.progress_id.clone();
    let monorepo_enabled = input.monorepo_enabled.unwrap_or(false);
    let monorepo_root = input
        .monorepo_root
        .clone()
        .unwrap_or_default()
        .trim()
        .to_string();
    let monorepo_parent_dir = input
        .monorepo_parent_dir
        .clone()
        .unwrap_or_default()
        .trim()
        .to_string();
    let monorepo_install_command = input
        .monorepo_install_command
        .clone()
        .unwrap_or_default()
        .trim()
        .to_string();

    if monorepo_enabled {
        if monorepo_root.is_empty() {
            return Err("Monorepo root is required.".to_string());
        }
        if !monorepo_parent_dir.is_empty() {
            let parent_path = Path::new(&monorepo_parent_dir);
            if parent_path.is_absolute()
                || parent_path.components().any(|component| {
                    matches!(
                        component,
                        Component::ParentDir | Component::RootDir | Component::Prefix(_)
                    )
                })
            {
                return Err(
                    "Monorepo parent directory must be a relative path without .. segments."
                        .to_string(),
                );
            }
        }
        if monorepo_install_command.is_empty() {
            return Err("Monorepo install command is required.".to_string());
        }
    }

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
    if monorepo_enabled
        && local_path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("Project path cannot include .. segments.".to_string());
    }

    let parent_dir = local_path
        .parent()
        .ok_or_else(|| "Invalid project path.".to_string())?;
    let monorepo_root_path = if monorepo_enabled {
        let root_path = PathBuf::from(&monorepo_root);
        if !root_path.exists() {
            return Err("Monorepo root folder does not exist.".to_string());
        }
        if !root_path.is_dir() {
            return Err("Monorepo root must be a directory.".to_string());
        }
        if local_path.strip_prefix(&root_path).is_err() {
            return Err("Project path must be inside the monorepo root.".to_string());
        }
        Some(root_path)
    } else {
        None
    };
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

    if monorepo_enabled {
        let root_path = monorepo_root_path
            .as_ref()
            .ok_or_else(|| "Monorepo root unavailable.".to_string())?;
        emit_progress(
            &app,
            &progress_id,
            "Merging Falck config into monorepo",
            None,
        );
        merge_falck_config_with_opencode(
            &app,
            opencode_state,
            root_path,
            &local_path,
            &monorepo_install_command,
        )?;
        emit_progress(&app, &progress_id, "Finalizing project", None);
        let repo_name = root_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("monorepo")
            .to_string();
        return Ok(CreateAstroProjectResult {
            path: root_path.to_string_lossy().to_string(),
            repo_name: Some(repo_name),
            repo_full_name: None,
            repo_ssh_url: None,
            branch: None,
        });
    }

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
        emit_progress(
            &app,
            &progress_id,
            "Creating initial commit",
            Some(message.clone()),
        );
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
    if let Err(err) = git::push_to_remote(&input.local_path, "origin", &branch, &input.ssh_key_path)
    {
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
        repo_name: Some(repo_name),
        repo_full_name: Some(repo_full_name),
        repo_ssh_url: Some(repo_ssh_url),
        branch: Some(branch),
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
    let description = input
        .description
        .clone()
        .filter(|text| !text.trim().is_empty());

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

fn merge_falck_config_with_opencode(
    app: &AppHandle,
    opencode_state: State<'_, opencode::OpencodeState>,
    monorepo_root: &Path,
    app_path: &Path,
    install_command: &str,
) -> Result<(), String> {
    let directory = monorepo_root.to_string_lossy().to_string();
    let session_data = opencode::opencode_send(
        app.clone(),
        opencode_state,
        "createSession".to_string(),
        json!({
            "name": "Falck monorepo merge",
            "description": "Merge Falck config from Astro template into monorepo",
            "directory": directory,
        }),
    )?;

    let session_path = session_data
        .get("sessionPath")
        .and_then(|value| value.as_str())
        .or_else(|| {
            session_data
                .get("session")
                .and_then(|session| session.get("path"))
                .and_then(|value| value.as_str())
        })
        .ok_or_else(|| "OpenCode session path missing.".to_string())?;

    let app_relative = app_path.strip_prefix(monorepo_root).unwrap_or(app_path);
    let app_relative_str = app_relative.to_string_lossy().replace('\\', "/");
    let app_root_value = if app_relative_str.is_empty() {
        ".".to_string()
    } else {
        app_relative_str.clone()
    };
    let template_config_path = if app_relative_str.is_empty() {
        ".falck/config.yaml".to_string()
    } else {
        format!("{}/.falck/config.yaml", app_relative_str)
    };
    let template_config_dir = if app_relative_str.is_empty() {
        ".falck".to_string()
    } else {
        format!("{}/.falck", app_relative_str)
    };
    let prompt = format!(
        "We just scaffolded an Astro app inside this monorepo.\n\n\
Template Falck config: `{template_config}`\n\
Target Falck config: `.falck/config.yaml`\n\n\
Please move the Falck config from the template into the monorepo root.\n\
- If `.falck/config.yaml` already exists, merge the new app into the existing config without removing existing applications or metadata.\n\
- If it doesn't exist, create it based on the template config.\n\
- Ensure the new application's `root` is set to `{app_root}` (relative to the monorepo root).\n\
- Update or add the install dependencies setup step so it runs from the monorepo root using: `cd {{{{ repo_root }}}} && {install_command}`.\n\
- Remove `{template_dir}` after merging.\n\
Only touch Falck config files for this change and keep YAML formatting clean. Return a brief summary.",
        template_config = template_config_path,
        app_root = app_root_value,
        install_command = install_command,
        template_dir = template_config_dir,
    );

    let state = app.state::<opencode::OpencodeState>();
    opencode::opencode_send(
        app.clone(),
        state,
        "prompt".to_string(),
        json!({
            "sessionPath": session_path,
            "message": prompt,
            "directory": directory,
        }),
    )?;

    Ok(())
}

fn build_astro_options(input: &CreateAstroProjectRequest) -> AstroCreateOptions {
    let prompt_mode = match input.prompt_mode.as_deref() {
        Some("no") => "no",
        _ => "yes",
    };
    let monorepo_enabled = input.monorepo_enabled.unwrap_or(false);

    AstroCreateOptions {
        prompt_mode: prompt_mode.to_string(),
        install_dependencies: if monorepo_enabled {
            false
        } else {
            input.install_dependencies.unwrap_or(true)
        },
        initialize_git: if monorepo_enabled {
            false
        } else {
            input.initialize_git.unwrap_or(false)
        },
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

fn ensure_bun_installed(app: &AppHandle, progress_id: &Option<String>) -> Result<PathBuf, String> {
    if let Some(path) = resolve_bun_path(app) {
        return Ok(path);
    }
    emit_progress(app, progress_id, "Installing Bun", None);
    install_bun()?;
    resolve_bun_path(app)
        .ok_or_else(|| "Bun installed but was not found. Add ~/.bun/bin to your PATH.".to_string())
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

    output
        .map(|result| result.status.success())
        .unwrap_or(false)
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
