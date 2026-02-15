import { invoke } from "@tauri-apps/api/core";

export interface GithubDeviceResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string | null;
  expires_in: number;
  interval: number;
}

export interface GithubTokenInfo {
  token_type: string;
  scope: string;
}

export interface GithubUser {
  login: string;
  id: number;
  name?: string | null;
  avatar_url?: string | null;
}

export interface GithubRepoOwner {
  login: string;
  avatar_url?: string | null;
}

export interface GithubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  ssh_url: string;
  clone_url: string;
  default_branch?: string | null;
  updated_at?: string | null;
  fork: boolean;
  archived: boolean;
  disabled: boolean;
  owner: GithubRepoOwner;
}

export interface GithubPullRequest {
  id: number;
  number: number;
  html_url: string;
  url: string;
  state: string;
  title: string;
}

export interface GithubCollaborator {
  login: string;
  id: number;
  name?: string | null;
  avatar_url?: string | null;
}

export interface GithubReviewRequestResult {
  requested: string[];
  skipped: string[];
}

export const githubService = {
  async startDeviceFlow(scope?: string): Promise<GithubDeviceResponse> {
    return invoke<GithubDeviceResponse>("github_start_device_flow", {
      scope: scope ?? null,
    });
  },

  async pollDeviceToken(
    deviceCode: string,
    interval: number,
    expiresIn: number,
  ): Promise<GithubTokenInfo> {
    return invoke<GithubTokenInfo>("github_poll_device_token", {
      deviceCode,
      interval,
      expiresIn,
    });
  },

  async hasToken(): Promise<boolean> {
    return invoke<boolean>("github_has_token");
  },

  async clearToken(): Promise<void> {
    return invoke<void>("github_clear_token");
  },

  async getUser(): Promise<GithubUser> {
    return invoke<GithubUser>("github_get_user");
  },

  async listRepos(): Promise<GithubRepo[]> {
    return invoke<GithubRepo[]>("github_list_repos");
  },

  async listRepoCollaborators(
    repoFullName: string,
  ): Promise<GithubCollaborator[]> {
    return invoke<GithubCollaborator[]>("github_list_repo_collaborators", {
      input: {
        repoFullName,
      },
    });
  },

  async createPullRequest(input: {
    repoFullName: string;
    title: string;
    head: string;
    base: string;
    body?: string;
    draft?: boolean;
  }): Promise<GithubPullRequest> {
    return invoke<GithubPullRequest>("github_create_pull_request", {
      input: {
        repoFullName: input.repoFullName,
        title: input.title,
        head: input.head,
        base: input.base,
        body: input.body ?? null,
        draft: input.draft ?? null,
      },
    });
  },

  async requestReviewers(input: {
    repoFullName: string;
    pullNumber: number;
    reviewers: string[];
  }): Promise<GithubReviewRequestResult> {
    return invoke<GithubReviewRequestResult>("github_request_reviewers", {
      input: {
        repoFullName: input.repoFullName,
        pullNumber: input.pullNumber,
        reviewers: input.reviewers,
      },
    });
  },

  async addSshKey(title: string, key: string): Promise<void> {
    return invoke<void>("github_add_ssh_key", { title, key });
  },
};
