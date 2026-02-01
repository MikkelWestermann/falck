import { invoke } from "@tauri-apps/api/core";

export interface FalckConfig {
  version: string;
  metadata?: {
    name?: string;
    description?: string;
    author?: string;
    created?: string;
    updated?: string;
  };
  repository?: {
    default_branch?: string;
    protect_default_branch?: boolean;
  };
  applications: FalckApplication[];
  global_env?: Record<string, string>;
  install_order?: string[];
  launch_order?: string[];
  groups?: AppGroup[];
}

export interface FalckApplication {
  id: string;
  name: string;
  type: string;
  description?: string;
  root: string;
  prerequisites?: Prerequisite[];
  secrets?: Secret[];
  setup?: SetupConfig;
  launch: LaunchConfig;
  cleanup?: CleanupConfig;
}

export interface Prerequisite {
  type: string;
  name: string;
  command: string;
  version?: string;
  install_url?: string;
  optional?: boolean;
}

export interface Secret {
  name: string;
  description: string;
  required: boolean;
}

export interface SetupConfig {
  steps?: SetupStep[];
}

export interface SetupStep {
  name: string;
  command: string;
  description?: string;
  timeout?: number;
  silent?: boolean;
  optional?: boolean;
  only_if?: string;
}

export interface LaunchConfig {
  command: string;
  description?: string;
  timeout?: number;
  access?: AccessConfig;
  env?: Record<string, string>;
  ports?: number[];
}

export interface AccessConfig {
  type: string;
  url?: string;
  open_browser?: boolean;
  port?: number;
  ready_signal?: string;
}

export interface CleanupConfig {
  steps?: CleanupStep[];
}

export interface CleanupStep {
  name: string;
  command: string;
  description?: string;
  timeout?: number;
  only_if?: string;
}

export interface AppGroup {
  name: string;
  apps: string[];
}

export interface PrerequisiteCheckResult {
  name: string;
  command: string;
  installed: boolean;
  required_version?: string;
  current_version?: string;
  install_url?: string;
  optional: boolean;
}

export const falckService = {
  async loadConfig(repoPath: string): Promise<FalckConfig> {
    return invoke<FalckConfig>("load_falck_config", {
      repoPath,
    });
  },

  async getAppSecrets(repoPath: string, appId: string): Promise<Secret[]> {
    return invoke<Secret[]>("get_app_secrets_for_config", {
      repoPath,
      appId,
    });
  },

  async setSecret(name: string, value: string): Promise<void> {
    return invoke<void>("set_app_secret", {
      name,
      value,
    });
  },

  async checkSecretsSatisfied(repoPath: string, appId: string): Promise<boolean> {
    return invoke<boolean>("check_secrets_satisfied", {
      repoPath,
      appId,
    });
  },

  async checkPrerequisites(
    repoPath: string,
    appId: string,
  ): Promise<PrerequisiteCheckResult[]> {
    return invoke<PrerequisiteCheckResult[]>("check_falck_prerequisites", {
      repoPath,
      appId,
    });
  },

  async runSetup(repoPath: string, appId: string): Promise<string> {
    return invoke<string>("run_falck_setup", {
      repoPath,
      appId,
    });
  },

  async runCleanup(repoPath: string, appId: string): Promise<string> {
    return invoke<string>("run_falck_cleanup", {
      repoPath,
      appId,
    });
  },

  async launchApp(repoPath: string, appId: string): Promise<number> {
    return invoke<number>("launch_falck_app", {
      repoPath,
      appId,
    });
  },

  async killApp(pid: number): Promise<void> {
    return invoke<void>("kill_falck_app", {
      pid,
    });
  },

  async isPortAvailable(port: number): Promise<boolean> {
    return invoke<boolean>("check_port_available", {
      port,
    });
  },

  async openInBrowser(url: string): Promise<void> {
    return invoke<void>("open_browser_to_url", {
      url,
    });
  },

  async clearSecrets(): Promise<void> {
    return invoke<void>("clear_all_secrets");
  },
};
