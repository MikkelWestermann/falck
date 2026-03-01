import { invoke } from "@tauri-apps/api/core";

export interface LimaStatus {
  installed: boolean;
  version?: string;
  path?: string;
  source?: "system" | "bundled";
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

export interface ContainerMountDetail {
  source?: string;
  destination?: string;
  mode?: string;
  rw?: boolean;
  kind?: string;
}

export interface ContainerPortDetail {
  container_port?: string;
  host_port?: string;
  protocol?: string;
}

export interface ContainerDetails {
  id: string;
  repo_path: string;
  app_id?: string;
  name: string;
  vm: string;
  image?: string;
  status?: string;
  state: "running" | "stopped" | "unknown";
  last_used: number;
  created?: string;
  mounts: ContainerMountDetail[];
  ports: ContainerPortDetail[];
  workdir?: string;
  env: string[];
  inspect_error?: string;
}

export const containerService = {
  async checkLimaInstalled(): Promise<LimaStatus> {
    return invoke<LimaStatus>("check_lima_installed");
  },

  async listContainers(repoPath?: string): Promise<ContainerInfo[]> {
    return invoke<ContainerInfo[]>("list_containers", {
      repoPath,
    });
  },

  async getContainerDetails(
    id: string,
    vm: string,
    name: string,
  ): Promise<ContainerDetails> {
    return invoke<ContainerDetails>("get_container_details", {
      id,
      vm,
      name,
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
