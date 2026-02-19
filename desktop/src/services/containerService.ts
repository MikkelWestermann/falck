import { invoke } from "@tauri-apps/api/core";

export interface LimaStatus {
  installed: boolean;
  version?: string;
  path?: string;
}

export interface LimaInstallResult {
  version: string;
  path: string;
}

export interface ContainerInfo {
  id: string;
  repo_path: string;
  app_id?: string;
  name: string;
  vm: string;
  image?: string;
  status?: string;
  state: "running" | "stopped" | "unknown";
  last_used: number;
}

export const containerService = {
  async checkLimaInstalled(): Promise<LimaStatus> {
    return invoke<LimaStatus>("check_lima_installed");
  },

  async installLima(): Promise<LimaInstallResult> {
    return invoke<LimaInstallResult>("install_lima");
  },

  async listContainers(repoPath?: string): Promise<ContainerInfo[]> {
    return invoke<ContainerInfo[]>("list_containers", {
      repoPath,
    });
  },

  async startContainer(id: string, vm: string, name: string): Promise<string> {
    return invoke<string>("start_container", {
      id,
      vm,
      name,
    });
  },

  async stopContainer(id: string, vm: string, name: string): Promise<string> {
    return invoke<string>("stop_container", {
      id,
      vm,
      name,
    });
  },

  async deleteContainer(id: string, vm: string, name: string): Promise<string> {
    return invoke<string>("delete_container", {
      id,
      vm,
      name,
    });
  },
};
