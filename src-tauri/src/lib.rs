mod git;
mod opencode;
mod storage;

use git::{
    checkout_branch, clone_repository, create_branch, create_commit, delete_branch,
    get_commit_history, get_repository_info, list_remotes, pull_from_remote, push_to_remote,
    stage_file, unstage_file,
};
use opencode::{opencode_send, OpencodeState};
use storage::{list_repos, save_repo, SavedRepo};

// ============================================================================
// Tauri Commands
// ============================================================================

#[tauri::command]
fn clone_repo(url: String, path: String) -> Result<String, String> {
    clone_repository(&url, &path).map_err(|e| e.to_string())?;
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
fn push(path: String, remote: String, branch: String) -> Result<String, String> {
    push_to_remote(&path, &remote, &branch).map_err(|e| e.to_string())?;
    Ok("Pushed successfully".to_string())
}

#[tauri::command]
fn pull(path: String, remote: String, branch: String) -> Result<String, String> {
    pull_from_remote(&path, &remote, &branch).map_err(|e| e.to_string())?;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(OpencodeState::default())
        .invoke_handler(tauri::generate_handler![
            clone_repo,
            get_repo_info,
            get_commits,
            stage,
            unstage,
            commit,
            create_new_branch,
            delete_current_branch,
            checkout,
            push,
            pull,
            get_remotes,
            save_repo_entry,
            list_repo_entries,
            opencode_send,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
