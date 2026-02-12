use git2::{
    build::RepoBuilder, BranchType, Cred, CredentialType, FetchOptions, IndexAddOption,
    PushOptions, RemoteCallbacks, Repository, RepositoryInitOptions, ResetType, Signature,
    Sort, StatusOptions,
};
use serde::{Deserialize, Serialize};
use std::path::Path;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum GitError {
    #[error("Git error: {0}")]
    Git(String),
    #[error("Repository not found")]
    RepositoryNotFound,
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

impl From<git2::Error> for GitError {
    fn from(err: git2::Error) -> Self {
        GitError::Git(err.message().to_string())
    }
}

pub type GitResult<T> = Result<T, GitError>;

// ============================================================================
// Data Structures
// ============================================================================

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CommitInfo {
    pub id: String,
    pub author: String,
    pub message: String,
    pub timestamp: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BranchInfo {
    pub name: String,
    pub is_head: bool,
    pub upstream: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileStatus {
    pub path: String,
    pub status: String, // "modified", "added", "deleted", "renamed", "untracked"
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RepositoryInfo {
    pub path: String,
    pub head_branch: String,
    pub is_dirty: bool,
    pub branches: Vec<BranchInfo>,
    pub status_files: Vec<FileStatus>,
}

fn resolve_reference_commit<'a>(
    repo: &'a Repository,
    reference: &str,
) -> GitResult<git2::Commit<'a>> {
    if let Ok(obj) = repo.revparse_single(reference) {
        return Ok(obj.peel_to_commit()?);
    }

    if !reference.starts_with("refs/") {
        let local_ref = format!("refs/heads/{}", reference);
        if let Ok(obj) = repo.revparse_single(&local_ref) {
            return Ok(obj.peel_to_commit()?);
        }

        let remote_ref = format!("refs/remotes/origin/{}", reference);
        if let Ok(obj) = repo.revparse_single(&remote_ref) {
            return Ok(obj.peel_to_commit()?);
        }
    }

    Err(GitError::Git(format!(
        "Branch '{}' not found",
        reference
    )))
}

// ============================================================================
// Repository Operations
// ============================================================================

fn configure_ssh_callbacks(callbacks: &mut RemoteCallbacks, ssh_key_path: &str) {
    let ssh_key_path = ssh_key_path.to_string();
    let public_key_path = format!("{}.pub", ssh_key_path);

    callbacks.certificate_check(|_, _| Ok(git2::CertificateCheckStatus::CertificateOk));
    callbacks.credentials(move |_, username_from_url, allowed_types| {
        let username = username_from_url.unwrap_or("git");

        if allowed_types.contains(CredentialType::SSH_KEY) {
            let public_key = {
                let path = Path::new(&public_key_path);
                if path.exists() {
                    Some(path)
                } else {
                    None
                }
            };

            if let Ok(cred) = Cred::ssh_key(
                username,
                public_key,
                Path::new(&ssh_key_path),
                None,
            ) {
                return Ok(cred);
            }

            return Cred::ssh_key_from_agent(username);
        }

        if allowed_types.contains(CredentialType::USERNAME) {
            return Cred::username(username);
        }

        Err(git2::Error::from_str("No supported SSH credentials available"))
    });
}

pub fn clone_repository(url: &str, local_path: &str, ssh_key_path: &str) -> GitResult<()> {
    if !Path::new(ssh_key_path).exists() {
        return Err(GitError::Git("SSH key not found".to_string()));
    }

    let mut callbacks = RemoteCallbacks::new();
    configure_ssh_callbacks(&mut callbacks, ssh_key_path);

    let mut fetch_options = FetchOptions::new();
    fetch_options.remote_callbacks(callbacks);

    let mut builder = RepoBuilder::new();
    builder.fetch_options(fetch_options);
    builder.clone(url, Path::new(local_path))?;
    Ok(())
}

pub fn open_repository(path: &str) -> GitResult<Repository> {
    let repo = Repository::open(path).map_err(|_| GitError::RepositoryNotFound)?;
    Ok(repo)
}

pub fn init_repository(path: &str) -> GitResult<()> {
    let mut opts = RepositoryInitOptions::new();
    opts.initial_head("main");
    Repository::init_opts(path, &opts)?;
    Ok(())
}

pub fn get_repository_info(path: &str) -> GitResult<RepositoryInfo> {
    let repo = open_repository(path)?;

    let head_branch = match repo.head() {
        Ok(head) => head.shorthand().unwrap_or("detached").to_string(),
        Err(_) => "detached".to_string(),
    };

    let mut branches = Vec::new();
    for branch_result in repo.branches(Some(BranchType::Local))? {
        let (branch, _) = branch_result?;
        let branch_name = branch.name()?.unwrap_or("unknown").to_string();
        branches.push(BranchInfo {
            name: branch_name,
            is_head: branch.is_head(),
            upstream: None,
        });
    }

    let mut status_files = Vec::new();
    let mut status_options = StatusOptions::new();
    status_options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false)
        .include_unmodified(false);
    let statuses = repo.statuses(Some(&mut status_options))?;
    for entry in statuses.iter() {
        let status = entry.status();
        if status.is_ignored() {
            continue;
        }
        let status_str = if status.is_wt_modified() || status.is_index_modified() {
            "modified"
        } else if status.is_wt_new() {
            "untracked"
        } else if status.is_index_new() {
            "added"
        } else if status.is_wt_deleted() || status.is_index_deleted() {
            "deleted"
        } else if status.is_wt_renamed() || status.is_index_renamed() {
            "renamed"
        } else {
            "unknown"
        };

        status_files.push(FileStatus {
            path: entry.path().unwrap_or("unknown").to_string(),
            status: status_str.to_string(),
        });
    }

    let is_dirty = !status_files.is_empty();

    Ok(RepositoryInfo {
        path: path.to_string(),
        head_branch,
        is_dirty,
        branches,
        status_files,
    })
}

pub fn has_commits(path: &str) -> GitResult<bool> {
    let repo = open_repository(path)?;
    let has_commit = repo
        .head()
        .ok()
        .and_then(|head| head.peel_to_commit().ok())
        .is_some();
    Ok(has_commit)
}

pub fn current_branch(path: &str) -> GitResult<String> {
    let repo = open_repository(path)?;
    let head = repo.head()?;
    Ok(head.shorthand().unwrap_or("detached").to_string())
}

pub fn ensure_main_branch(path: &str) -> GitResult<String> {
    let repo = open_repository(path)?;
    let head = repo.head()?;
    let current = head.shorthand().unwrap_or("main").to_string();
    if current == "main" {
        return Ok(current);
    }

    let main_exists = repo.find_branch("main", BranchType::Local).is_ok();
    if current == "master" && !main_exists {
        let mut branch = repo.find_branch("master", BranchType::Local)?;
        branch.rename("main", true)?;
    } else if !main_exists {
        let commit = head.peel_to_commit()?;
        repo.branch("main", &commit, false)?;
    }

    repo.set_head("refs/heads/main")?;
    repo.checkout_head(Some(
        git2::build::CheckoutBuilder::new().force(),
    ))?;
    Ok("main".to_string())
}

// ============================================================================
// Commit Operations
// ============================================================================

pub fn get_commit_history(path: &str, max_count: usize) -> GitResult<Vec<CommitInfo>> {
    let repo = open_repository(path)?;
    let mut revwalk = repo.revwalk()?;
    revwalk.push_head()?;
    revwalk.set_sorting(Sort::TIME)?;

    let mut commits = Vec::new();
    for oid in revwalk.take(max_count) {
        if let Ok(oid) = oid {
            let commit = repo.find_commit(oid)?;
            let author = commit.author().name().unwrap_or("unknown").to_string();
            let message = commit.message().unwrap_or("").to_string();
            let timestamp = commit.time().seconds();

            commits.push(CommitInfo {
                id: oid.to_string(),
                author,
                message,
                timestamp,
            });
        }
    }

    Ok(commits)
}

pub fn get_project_history(
    path: &str,
    base_branch: &str,
    max_count: usize,
) -> GitResult<Vec<CommitInfo>> {
    let repo = open_repository(path)?;
    let base_commit = resolve_reference_commit(&repo, base_branch)?;

    let mut revwalk = repo.revwalk()?;
    revwalk.push_head()?;
    revwalk.hide(base_commit.id())?;
    revwalk.set_sorting(Sort::TIME)?;

    let mut commits = Vec::new();
    for oid in revwalk.take(max_count) {
        if let Ok(oid) = oid {
            let commit = repo.find_commit(oid)?;
            let author = commit.author().name().unwrap_or("unknown").to_string();
            let message = commit.message().unwrap_or("").to_string();
            let timestamp = commit.time().seconds();

            commits.push(CommitInfo {
                id: oid.to_string(),
                author,
                message,
                timestamp,
            });
        }
    }

    Ok(commits)
}

pub fn reset_to_commit(path: &str, commit_id: &str) -> GitResult<()> {
    let repo = open_repository(path)?;
    let oid = git2::Oid::from_str(commit_id)?;
    let commit = repo.find_commit(oid)?;
    repo.reset(commit.as_object(), ResetType::Hard, None)?;
    Ok(())
}

pub fn discard_changes(path: &str) -> GitResult<()> {
    let repo = open_repository(path)?;
    let head = repo.head()?.peel_to_commit()?;
    repo.reset(head.as_object(), ResetType::Hard, None)?;

    let workdir = repo
        .workdir()
        .ok_or_else(|| GitError::Git("Repository workdir not found".to_string()))?;
    let mut status_options = StatusOptions::new();
    status_options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false)
        .include_unmodified(false);
    let statuses = repo.statuses(Some(&mut status_options))?;
    for entry in statuses.iter() {
        if entry.status().is_wt_new() {
            if let Some(path) = entry.path() {
                let full_path = workdir.join(path);
                if full_path.is_dir() {
                    std::fs::remove_dir_all(full_path)?;
                } else {
                    std::fs::remove_file(full_path)?;
                }
            }
        }
    }

    Ok(())
}

fn get_git_user_config(path: &str) -> (String, String) {
    let name = open_repository(path)
        .ok()
        .and_then(|repo| repo.config().ok())
        .and_then(|cfg| cfg.get_string("user.name").ok())
        .or_else(|| git2::Config::open_default().ok().and_then(|c| c.get_string("user.name").ok()))
        .unwrap_or_else(|| "User".to_string());
    let email = open_repository(path)
        .ok()
        .and_then(|repo| repo.config().ok())
        .and_then(|cfg| cfg.get_string("user.email").ok())
        .or_else(|| git2::Config::open_default().ok().and_then(|c| c.get_string("user.email").ok()))
        .unwrap_or_else(|| "user@local".to_string());
    (name, email)
}

pub fn create_commit(
    path: &str,
    message: &str,
    author_name: &str,
    author_email: &str,
) -> GitResult<String> {
    let repo = open_repository(path)?;

    let (name, email) = if author_name.trim().is_empty() || author_email.trim().is_empty() {
        get_git_user_config(path)
    } else {
        (author_name.to_string(), author_email.to_string())
    };

    let signature = Signature::now(&name, &email)?;
    let tree_id = {
        let mut index = repo.index()?;
        index.write_tree()?
    };

    let tree = repo.find_tree(tree_id)?;
    let parent_commit = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let oid = if let Some(parent) = parent_commit {
        repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            message,
            &tree,
            &[&parent],
        )?
    } else {
        repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            message,
            &tree,
            &[],
        )?
    };

    Ok(oid.to_string())
}

pub fn stage_file(path: &str, file_path: &str) -> GitResult<()> {
    let repo = open_repository(path)?;
    let mut index = repo.index()?;
    index.add_path(Path::new(file_path))?;
    index.write()?;
    Ok(())
}

pub fn stage_all(path: &str) -> GitResult<()> {
    let repo = open_repository(path)?;
    let mut index = repo.index()?;
    index.add_all(["*"].iter(), IndexAddOption::DEFAULT, None)?;
    index.write()?;
    Ok(())
}

pub fn unstage_file(path: &str, file_path: &str) -> GitResult<()> {
    let repo = open_repository(path)?;
    let mut index = repo.index()?;
    index.remove_path(Path::new(file_path))?;
    index.write()?;
    Ok(())
}

// ============================================================================
// Branch Operations
// ============================================================================

pub fn create_branch(path: &str, branch_name: &str) -> GitResult<()> {
    let repo = open_repository(path)?;
    let head = repo.head()?;
    let commit = head.peel_to_commit()?;
    repo.branch(branch_name, &commit, false)?;
    Ok(())
}

pub fn delete_branch(path: &str, branch_name: &str) -> GitResult<()> {
    let repo = open_repository(path)?;
    let mut branch = repo.find_branch(branch_name, BranchType::Local)?;
    branch.delete()?;
    Ok(())
}

pub fn checkout_branch(path: &str, branch_name: &str) -> GitResult<()> {
    let repo = open_repository(path)?;
    let refname = format!("refs/heads/{}", branch_name);
    repo.set_head(&refname)?;
    repo.checkout_head(Some(
        git2::build::CheckoutBuilder::new().force(),
    ))?;
    Ok(())
}

// ============================================================================
// Push/Pull Operations
// ============================================================================

pub fn push_to_remote(
    path: &str,
    remote_name: &str,
    branch_name: &str,
    ssh_key_path: &str,
) -> GitResult<()> {
    if !Path::new(ssh_key_path).exists() {
        return Err(GitError::Git("SSH key not found".to_string()));
    }

    let repo = open_repository(path)?;
    let mut remote = repo.find_remote(remote_name)?;
    let refspec = format!("refs/heads/{0}:refs/heads/{0}", branch_name);

    let mut callbacks = RemoteCallbacks::new();
    configure_ssh_callbacks(&mut callbacks, ssh_key_path);

    let mut push_options = PushOptions::new();
    push_options.remote_callbacks(callbacks);
    remote.push(&[&refspec], Some(&mut push_options))?;
    Ok(())
}

pub fn pull_from_remote(
    path: &str,
    remote_name: &str,
    branch_name: &str,
    ssh_key_path: &str,
) -> GitResult<()> {
    if !Path::new(ssh_key_path).exists() {
        return Err(GitError::Git("SSH key not found".to_string()));
    }

    let repo = open_repository(path)?;
    let mut remote = repo.find_remote(remote_name)?;

    let mut callbacks = RemoteCallbacks::new();
    configure_ssh_callbacks(&mut callbacks, ssh_key_path);

    let mut fetch_options = FetchOptions::new();
    fetch_options.remote_callbacks(callbacks);

    remote.fetch(&[branch_name], Some(&mut fetch_options), None)?;

    let fetch_head = repo.find_reference("FETCH_HEAD")?;
    let fetch_commit = repo.reference_to_annotated_commit(&fetch_head)?;

    let (analysis, _) = repo.merge_analysis(&[&fetch_commit])?;

    if analysis.is_up_to_date() {
        return Ok(());
    }

    if analysis.is_fast_forward() {
        let refname = format!("refs/heads/{}", branch_name);
        match repo.find_reference(&refname) {
            Ok(mut reference) => {
                reference.set_target(fetch_commit.id(), "Fast-Forward")?;
            }
            Err(_) => {
                repo.reference(&refname, fetch_commit.id(), true, "Setting ref")?;
            }
        }
        repo.set_head(&refname)?;
        repo.checkout_head(Some(
            git2::build::CheckoutBuilder::new().force(),
        ))?;
        return Ok(());
    }

    Err(GitError::Git(
        "Merge required, not implemented".to_string(),
    ))
}

pub fn list_remotes(path: &str) -> GitResult<Vec<String>> {
    let repo = open_repository(path)?;
    let remotes = repo.remotes()?;
    let mut remote_names = Vec::new();

    for name in remotes.iter().flatten() {
        remote_names.push(name.to_string());
    }

    Ok(remote_names)
}

pub fn add_or_update_remote(path: &str, name: &str, url: &str) -> GitResult<()> {
    let repo = open_repository(path)?;
    if repo.find_remote(name).is_ok() {
        repo.remote_set_url(name, url)?;
    } else {
        repo.remote(name, url)?;
    }
    Ok(())
}
