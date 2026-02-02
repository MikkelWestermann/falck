mod git;
mod falck;
mod github;
mod opencode;
mod ssh;
mod storage;

use git::{
    checkout_branch, clone_repository, create_branch, create_commit, delete_branch,
    discard_changes as discard_git_changes, get_commit_history, get_project_history,
    get_repository_info, list_remotes, pull_from_remote, push_to_remote,
    reset_to_commit as reset_git_to_commit, stage_file, unstage_file,
};
use opencode::{
    check_command_exists, check_opencode_installed, install_opencode, opencode_send,
    OpencodeState,
};
use storage::{get_default_repo_dir, list_repos, save_repo, set_default_repo_dir, SavedRepo};
use reqwest::Client;

// ============================================================================
// Tauri Commands
// ============================================================================

#[tauri::command]
fn clone_repo(url: String, path: String, ssh_key_path: Option<String>) -> Result<String, String> {
    let ssh_key_path =
        ssh_key_path.ok_or_else(|| "SSH key is required to clone repositories.".to_string())?;
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    clone_repository(&url, &path, &ssh_key_path).map_err(|e| e.to_string())?;
    Ok("Repository cloned successfully".to_string())
}

#[tauri::command]
fn get_repo_info(path: String) -> Result<git::RepositoryInfo, String> {
    get_repository_info(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_commits(path: String, count: usize) -> Result<Vec<git::CommitInfo>, String> {
    get_commit_history(&path, count).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_project_commits(
    path: String,
    base_branch: String,
    count: usize,
) -> Result<Vec<git::CommitInfo>, String> {
    get_project_history(&path, &base_branch, count).map_err(|e| e.to_string())
}

#[tauri::command]
fn stage(path: String, file: String) -> Result<String, String> {
    stage_file(&path, &file).map_err(|e| e.to_string())?;
    Ok("File staged".to_string())
}

#[tauri::command]
fn unstage(path: String, file: String) -> Result<String, String> {
    unstage_file(&path, &file).map_err(|e| e.to_string())?;
    Ok("File unstaged".to_string())
}

#[tauri::command]
fn commit(path: String, message: String, author: String, email: String) -> Result<String, String> {
    create_commit(&path, &message, &author, &email).map_err(|e| e.to_string())
}

#[tauri::command]
fn reset_to_commit(path: String, commit_id: String) -> Result<String, String> {
    reset_git_to_commit(&path, &commit_id).map_err(|e| e.to_string())?;
    Ok("Reset to selected commit".to_string())
}

#[tauri::command]
fn discard_changes(path: String) -> Result<String, String> {
    discard_git_changes(&path).map_err(|e| e.to_string())?;
    Ok("Discarded changes".to_string())
}

#[tauri::command]
fn create_new_branch(path: String, branch: String) -> Result<String, String> {
    create_branch(&path, &branch).map_err(|e| e.to_string())?;
    Ok(format!("Branch '{}' created", branch))
}

#[tauri::command]
fn delete_current_branch(path: String, branch: String) -> Result<String, String> {
    delete_branch(&path, &branch).map_err(|e| e.to_string())?;
    Ok(format!("Branch '{}' deleted", branch))
}

#[tauri::command]
fn checkout(path: String, branch: String) -> Result<String, String> {
    checkout_branch(&path, &branch).map_err(|e| e.to_string())?;
    Ok(format!("Checked out branch '{}'", branch))
}

#[tauri::command]
fn push(
    path: String,
    remote: String,
    branch: String,
    ssh_key_path: Option<String>,
) -> Result<String, String> {
    let ssh_key_path = ssh_key_path.ok_or_else(|| "SSH key is required to push.".to_string())?;
    push_to_remote(&path, &remote, &branch, &ssh_key_path).map_err(|e| e.to_string())?;
    Ok("Pushed successfully".to_string())
}

#[tauri::command]
fn pull(
    path: String,
    remote: String,
    branch: String,
    ssh_key_path: Option<String>,
) -> Result<String, String> {
    let ssh_key_path = ssh_key_path.ok_or_else(|| "SSH key is required to pull.".to_string())?;
    pull_from_remote(&path, &remote, &branch, &ssh_key_path).map_err(|e| e.to_string())?;
    Ok("Pulled successfully".to_string())
}

#[tauri::command]
fn get_remotes(path: String) -> Result<Vec<String>, String> {
    list_remotes(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_repo_entry(
    app: tauri::AppHandle,
    name: String,
    path: String,
) -> Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;
    save_repo(&app, &name, &path, now)
}

#[tauri::command]
fn list_repo_entries(app: tauri::AppHandle) -> Result<Vec<SavedRepo>, String> {
    list_repos(&app)
}

#[tauri::command]
fn get_default_repo_directory(app: tauri::AppHandle) -> Result<String, String> {
    get_default_repo_dir(&app)
}

#[tauri::command]
fn set_default_repo_directory(app: tauri::AppHandle, path: String) -> Result<(), String> {
    set_default_repo_dir(&app, &path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Client::new())
        .manage(OpencodeState::default())
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
            save_repo_entry,
            list_repo_entries,
            get_default_repo_directory,
            set_default_repo_directory,
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
            github::github_add_ssh_key,
            falck::load_falck_config,
            falck::check_falck_prerequisites,
            falck::get_app_secrets_for_config,
            falck::set_app_secret,
            falck::check_secrets_satisfied,
            falck::check_falck_setup,
            falck::run_falck_setup,
            falck::launch_falck_app,
            falck::run_falck_cleanup,
            falck::kill_falck_app,
            falck::check_port_available,
            falck::open_browser_to_url,
            falck::clear_all_secrets,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
