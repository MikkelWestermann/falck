import { invoke } from "@tauri-apps/api/core";

export const settingsService = {
  async getDefaultRepoDir(): Promise<string> {
    return invoke("get_default_repo_directory");
  },

  async setDefaultRepoDir(path: string): Promise<void> {
    return invoke("set_default_repo_directory", { path });
  },
};
