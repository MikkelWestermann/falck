import { invoke } from "@tauri-apps/api/core";

export interface CommitInfo {
  id: string;
  author: string;
  message: string;
  timestamp: number;
}

export interface BranchInfo {
  name: string;
  is_head: boolean;
  upstream: string | null;
}

export interface FileStatus {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked" | "unknown";
}

export interface RepositoryInfo {
  path: string;
  head_branch: string;
  is_dirty: boolean;
  branches: BranchInfo[];
  status_files: FileStatus[];
}

export interface SavedRepo {
  name: string;
  path: string;
  last_opened: number;
}

export const gitService = {
  async cloneRepository(url: string, path: string): Promise<string> {
    return invoke("clone_repo", { url, path });
  },

  async getRepositoryInfo(path: string): Promise<RepositoryInfo> {
    return invoke("get_repo_info", { path });
  },

  async getCommitHistory(path: string, count = 50): Promise<CommitInfo[]> {
    return invoke("get_commits", { path, count });
  },

  async stageFile(path: string, file: string): Promise<string> {
    return invoke("stage", { path, file });
  },

  async unstageFile(path: string, file: string): Promise<string> {
    return invoke("unstage", { path, file });
  },

  async createCommit(
    path: string,
    message: string,
    author: string,
    email: string,
  ): Promise<string> {
    return invoke("commit", { path, message, author, email });
  },

  async createBranch(path: string, branch: string): Promise<string> {
    return invoke("create_new_branch", { path, branch });
  },

  async deleteBranch(path: string, branch: string): Promise<string> {
    return invoke("delete_current_branch", { path, branch });
  },

  async checkoutBranch(path: string, branch: string): Promise<string> {
    return invoke("checkout", { path, branch });
  },

  async push(path: string, remote: string, branch: string): Promise<string> {
    return invoke("push", { path, remote, branch });
  },

  async pull(path: string, remote: string, branch: string): Promise<string> {
    return invoke("pull", { path, remote, branch });
  },

  async getRemotes(path: string): Promise<string[]> {
    return invoke("get_remotes", { path });
  },

  async saveRepo(name: string, path: string): Promise<void> {
    return invoke("save_repo_entry", { name, path });
  },

  async listSavedRepos(): Promise<SavedRepo[]> {
    return invoke("list_repo_entries");
  },
};
