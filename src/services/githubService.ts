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

  async addSshKey(title: string, key: string): Promise<void> {
    return invoke<void>("github_add_ssh_key", { title, key });
  },
};
