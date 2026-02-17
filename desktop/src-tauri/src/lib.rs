mod falck;
mod git;
mod github;
mod backend;
mod opencode;
mod project;
mod ssh;
mod storage;
mod blocking;

use git::{
    checkout_branch, clone_repository, create_branch, create_commit, current_branch, delete_branch,
    discard_changes as discard_git_changes, get_commit_history, get_project_history,
    get_remote_url as get_git_remote_url, get_repository_info, list_remotes, pull_from_remote,
    push_to_remote, reset_to_commit as reset_git_to_commit, stage_file, unstage_file,
};
use opencode::{
    check_command_exists, check_opencode_installed, install_opencode, opencode_send, OpencodeState,
};
use reqwest::Client;
use storage::{
    get_default_repo_dir, list_repos, remove_repo, save_repo, set_default_repo_dir, SavedRepo,
};
use tauri::Manager;
use blocking::run_blocking;

// ============================================================================
// Tauri Commands
// ============================================================================

#[tauri::command]
async fn clone_repo(url: String, path: String, ssh_key_path: Option<String>) -> Result<String, String> {
    run_blocking(move || {
        let ssh_key_path =
            ssh_key_path.ok_or_else(|| "SSH key is required to clone repositories.".to_string())?;
        if let Some(parent) = std::path::Path::new(&path).parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        clone_repository(&url, &path, &ssh_key_path).map_err(|e| e.to_string())?;
        Ok("Repository cloned successfully".to_string())
    }).await
}

#[tauri::command]
async fn get_repo_info(path: String) -> Result<git::RepositoryInfo, String> {
    run_blocking(move || get_repository_info(&path).map_err(|e| e.to_string())).await
}

#[tauri::command]
async fn get_commits(path: String, count: usize) -> Result<Vec<git::CommitInfo>, String> {
    run_blocking(move || get_commit_history(&path, count).map_err(|e| e.to_string())).await
}

#[tauri::command]
async fn get_project_commits(
    path: String,
    base_branch: String,
    count: usize,
) -> Result<Vec<git::CommitInfo>, String> {
    run_blocking(move || get_project_history(&path, &base_branch, count).map_err(|e| e.to_string())).await
}

#[tauri::command]
async fn stage(path: String, file: String) -> Result<String, String> {
    run_blocking(move || {
        stage_file(&path, &file).map_err(|e| e.to_string())?;
        Ok("File staged".to_string())
    }).await
}

#[tauri::command]
async fn unstage(path: String, file: String) -> Result<String, String> {
    run_blocking(move || {
        unstage_file(&path, &file).map_err(|e| e.to_string())?;
        Ok("File unstaged".to_string())
    }).await
}

#[tauri::command]
async fn commit(path: String, message: String, author: String, email: String) -> Result<String, String> {
    run_blocking(move || create_commit(&path, &message, &author, &email).map_err(|e| e.to_string())).await
}

#[tauri::command]
async fn reset_to_commit(path: String, commit_id: String) -> Result<String, String> {
    run_blocking(move || {
        reset_git_to_commit(&path, &commit_id).map_err(|e| e.to_string())?;
        Ok("Reset to selected commit".to_string())
    }).await
}

#[tauri::command]
async fn discard_changes(path: String) -> Result<String, String> {
    run_blocking(move || {
        discard_git_changes(&path).map_err(|e| e.to_string())?;
        Ok("Discarded changes".to_string())
    }).await
}

#[tauri::command]
async fn create_new_branch(path: String, branch: String) -> Result<String, String> {
    run_blocking(move || {
        create_branch(&path, &branch).map_err(|e| e.to_string())?;
        Ok(format!("Branch '{}' created", branch))
    }).await
}

#[tauri::command]
async fn delete_current_branch(path: String, branch: String) -> Result<String, String> {
    run_blocking(move || {
        if let Ok(current) = current_branch(&path) {
            if current == branch {
                return Err("Cannot delete the current branch.".to_string());
            }
        }
        delete_branch(&path, &branch).map_err(|e| e.to_string())?;
        Ok(format!("Branch '{}' deleted", branch))
    }).await
}

#[tauri::command]
async fn checkout(path: String, branch: String) -> Result<String, String> {
    run_blocking(move || {
        checkout_branch(&path, &branch).map_err(|e| e.to_string())?;
        Ok(format!("Checked out branch '{}'", branch))
    }).await
}

#[tauri::command]
async fn push(
    path: String,
    remote: String,
    branch: String,
    ssh_key_path: Option<String>,
) -> Result<String, String> {
    run_blocking(move || {
        let ssh_key_path = ssh_key_path.ok_or_else(|| "SSH key is required to push.".to_string())?;
        push_to_remote(&path, &remote, &branch, &ssh_key_path).map_err(|e| e.to_string())?;
        Ok("Pushed successfully".to_string())
    }).await
}

#[tauri::command]
async fn pull(
    path: String,
    remote: String,
    branch: String,
    ssh_key_path: Option<String>,
) -> Result<String, String> {
    run_blocking(move || {
        let ssh_key_path = ssh_key_path.ok_or_else(|| "SSH key is required to pull.".to_string())?;
        pull_from_remote(&path, &remote, &branch, &ssh_key_path).map_err(|e| e.to_string())?;
        Ok("Pulled successfully".to_string())
    }).await
}

#[tauri::command]
async fn get_remotes(path: String) -> Result<Vec<String>, String> {
    run_blocking(move || list_remotes(&path).map_err(|e| e.to_string())).await
}

#[tauri::command]
async fn get_remote_url(path: String, remote: String) -> Result<String, String> {
    run_blocking(move || get_git_remote_url(&path, &remote).map_err(|e| e.to_string())).await
}

#[tauri::command]
async fn save_repo_entry(app: tauri::AppHandle, name: String, path: String) -> Result<(), String> {
    run_blocking(move || {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_secs() as i64;
        save_repo(&app, &name, &path, now)
    }).await
}

#[tauri::command]
async fn list_repo_entries(app: tauri::AppHandle) -> Result<Vec<SavedRepo>, String> {
    run_blocking(move || list_repos(&app)).await
}

#[tauri::command]
async fn remove_repo_entry(app: tauri::AppHandle, path: String) -> Result<(), String> {
    run_blocking(move || remove_repo(&app, &path)).await
}

#[tauri::command]
async fn get_default_repo_directory(app: tauri::AppHandle) -> Result<String, String> {
    run_blocking(move || get_default_repo_dir(&app)).await
}

#[tauri::command]
async fn set_default_repo_directory(app: tauri::AppHandle, path: String) -> Result<(), String> {
    run_blocking(move || set_default_repo_dir(&app, &path)).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_stronghold::Builder::new(|_pass| todo!()).build())
        .plugin(tauri_plugin_dialog::init())
        .manage(Client::new())
        .manage(OpencodeState::default())
        .manage(falck::FalckProcessState::default())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let state = window.app_handle().state::<falck::FalckProcessState>();
                falck::stop_all_running_apps(&state);
            }
        })
        .invoke_handler(tauri::generate_handler![
            clone_repo,
            get_repo_info,
            get_commits,
            get_project_commits,
            stage,
            unstage,
            commit,
            reset_to_commit,
            discard_changes,
            create_new_branch,
            delete_current_branch,
            checkout,
            push,
            pull,
            get_remotes,
            get_remote_url,
            save_repo_entry,
            list_repo_entries,
            remove_repo_entry,
            get_default_repo_directory,
            set_default_repo_directory,
            backend::get_backend_mode,
            backend::set_backend_mode,
            backend::check_virtualized_backend_prereq,
            backend::install_virtualized_backend_prereq,
            backend::ensure_repo_backend,
            backend::stop_repo_backend,
            backend::delete_repo_backend,
            backend::list_backend_vms,
            backend::stop_backend_vm,
            backend::delete_backend_vm,
            opencode_send,
            check_opencode_installed,
            install_opencode,
            check_command_exists,
            ssh::generate_new_ssh_key,
            ssh::list_ssh_keys,
            ssh::add_ssh_key_to_agent,
            ssh::test_ssh_github,
            ssh::get_current_os,
            github::github_start_device_flow,
            github::github_poll_device_token,
            github::github_has_token,
            github::github_clear_token,
            github::github_get_user,
            github::github_list_repos,
            github::github_list_repo_collaborators,
            github::github_request_reviewers,
            github::github_create_pull_request,
            github::github_add_ssh_key,
            project::create_astro_project,
            falck::load_falck_config,
            falck::check_falck_prerequisites,
            falck::run_falck_prerequisite_install,
            falck::get_app_secrets_for_config,
            falck::set_app_secret,
            falck::check_secrets_satisfied,
            falck::check_falck_setup,
            falck::run_falck_setup,
            falck::launch_falck_app,
            falck::run_falck_cleanup,
            falck::upload_falck_assets,
            falck::kill_falck_app,
            falck::check_port_available,
            falck::open_browser_to_url,
            falck::clear_all_secrets,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
