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
    branch_prefix?: string;
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
  assets?: AssetsConfig;
  prerequisites?: Prerequisite[];
  secrets?: Secret[];
  setup?: SetupConfig;
  launch: LaunchConfig;
  cleanup?: CleanupConfig;
}

export interface AssetsConfig {
  root: string;
  subdirectories?: string[];
}

export interface Prerequisite {
  type: string;
  name: string;
  command: string;
  version?: string;
  install_url?: string;
  install?: PrerequisiteInstall;
  optional?: boolean;
}

export type PrerequisiteInstallInstructions = string | string[];

export interface PrerequisiteInstallOption {
  name: string;
  command: string;
  description?: string;
  timeout?: number;
  silent?: boolean;
  only_if?: string;
}

export interface PrerequisiteInstall {
  instructions?: PrerequisiteInstallInstructions;
  options?: PrerequisiteInstallOption[];
}

export interface Secret {
  name: string;
  description: string;
  required: boolean;
}

export interface SetupConfig {
  steps?: SetupStep[];
  check?: SetupCheck;
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

export interface SetupCheck {
  command: string;
  description?: string;
  timeout?: number;
  silent?: boolean;
  only_if?: string;
  expect?: string;
  expect_contains?: string;
  expect_regex?: string;
  output?: "stdout" | "stderr" | "combined";
  trim?: boolean;
  ignore_exit?: boolean;
}

export interface SetupCheckResult {
  configured: boolean;
  complete: boolean;
  message?: string;
}

export interface ContainerHandle {
  id: string;
  name: string;
  vm: string;
  repo_path: string;
}

export type LaunchResult =
  | { kind: "process"; pid: number }
  | { kind: "container"; container: ContainerHandle };

export interface LaunchConfig {
  command?: string;
  description?: string;
  timeout?: number;
  access?: AccessConfig;
  env?: Record<string, string>;
  ports?: number[];
  container?: ContainerLaunchConfig;
}

export interface ContainerLaunchConfig {
  dockerfile: string;
  context?: string;
  image?: string;
  name?: string;
  vm?: string;
  workdir?: string;
  ports?: string[];
  mounts?: ContainerMount[];
}

export interface ContainerMount {
  source?: string;
  volume?: string;
  target: string;
  mode?: string;
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

export interface AssetUploadFile {
  name: string;
  bytes: number[];
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

  async runPrerequisiteInstall(
    repoPath: string,
    appId: string,
    prereqIndex: number,
    optionIndex: number,
  ): Promise<string> {
    return invoke<string>("run_falck_prerequisite_install", {
      repoPath,
      appId,
      prereqIndex,
      optionIndex,
    });
  },

  async runSetup(repoPath: string, appId: string): Promise<string> {
    return invoke<string>("run_falck_setup", {
      repoPath,
      appId,
    });
  },

  async checkSetupStatus(
    repoPath: string,
    appId: string,
  ): Promise<SetupCheckResult> {
    return invoke<SetupCheckResult>("check_falck_setup", {
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

  async launchApp(repoPath: string, appId: string): Promise<LaunchResult> {
    return invoke<LaunchResult>("launch_falck_app", {
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

  async resetApp(): Promise<string> {
    return invoke<string>("reset_app_state");
  },

  async uploadAssetFiles(
    repoPath: string,
    appId: string,
    targetSubdirectory: string | null,
    files: AssetUploadFile[],
  ): Promise<string[]> {
    return invoke<string[]>("upload_falck_assets", {
      repoPath,
      appId,
      targetSubdirectory,
      files,
    });
  },
};
