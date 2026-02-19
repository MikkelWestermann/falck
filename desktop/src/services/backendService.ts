import { invoke } from "@tauri-apps/api/core";

export type BackendMode = "host" | "virtualized";

export interface BackendPrereqStatus {
  installed: boolean;
  tool: string;
  message?: string;
}

export interface BackendEnsureResult {
  mode: BackendMode;
  vm_name?: string | null;
  provider?: string | null;
}

export interface BackendVmInfo {
  name: string;
  provider: string;
  status: string;
  repo_path?: string | null;
}

export const backendService = {
  async getMode(): Promise<BackendMode> {
    return invoke<BackendMode>("get_backend_mode");
  },

  async setMode(mode: BackendMode): Promise<void> {
    return invoke<void>("set_backend_mode", { mode });
  },

  async checkPrereq(): Promise<BackendPrereqStatus> {
    return invoke<BackendPrereqStatus>("check_virtualized_backend_prereq");
  },

  async installPrereq(): Promise<string> {
    return invoke<string>("install_virtualized_backend_prereq");
  },

  async ensureRepoBackend(repoPath: string): Promise<BackendEnsureResult> {
    return invoke<BackendEnsureResult>("ensure_repo_backend", { repoPath });
  },

  async stopRepoBackend(repoPath: string): Promise<void> {
    return invoke<void>("stop_repo_backend", { repoPath });
  },

  async deleteRepoBackend(repoPath: string): Promise<void> {
    return invoke<void>("delete_repo_backend", { repoPath });
  },

  async listVms(): Promise<BackendVmInfo[]> {
    return invoke<BackendVmInfo[]>("list_backend_vms");
  },

  async stopVm(name: string): Promise<void> {
    return invoke<void>("stop_backend_vm", { name });
  },

  async deleteVm(name: string): Promise<void> {
    return invoke<void>("delete_backend_vm", { name });
  },
};
