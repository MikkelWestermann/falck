use git2::{BranchType, Repository, Signature, Sort};
use serde::{Deserialize, Serialize};
use std::path::Path;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum GitError {
    #[error("Git error: {0}")]
    Git(String),
    #[error("Repository not found")]
    RepositoryNotFound,
    #[error("Invalid path")]
    InvalidPath,
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

// ============================================================================
// Repository Operations
// ============================================================================

pub fn clone_repository(url: &str, local_path: &str) -> GitResult<()> {
    Repository::clone(url, local_path)?;
    Ok(())
}

pub fn open_repository(path: &str) -> GitResult<Repository> {
    let repo = Repository::open(path).map_err(|_| GitError::RepositoryNotFound)?;
    Ok(repo)
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
    let statuses = repo.statuses(None)?;
    for entry in statuses.iter() {
        let status = entry.status();
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

pub fn create_commit(
    path: &str,
    message: &str,
    author_name: &str,
    author_email: &str,
) -> GitResult<String> {
    let repo = open_repository(path)?;

    let signature = Signature::now(author_name, author_email)?;
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

pub fn push_to_remote(path: &str, remote_name: &str, branch_name: &str) -> GitResult<()> {
    let repo = open_repository(path)?;
    let mut remote = repo.find_remote(remote_name)?;
    let refspec = format!("refs/heads/{0}:refs/heads/{0}", branch_name);
    remote.push(&[&refspec], None)?;
    Ok(())
}

pub fn pull_from_remote(path: &str, remote_name: &str, branch_name: &str) -> GitResult<()> {
    let repo = open_repository(path)?;
    let mut remote = repo.find_remote(remote_name)?;
    remote.fetch(&[branch_name], None, None)?;

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
