import { SSHKey } from "@/services/sshService";

export interface AppConfig {
  selectedSSHKey: SSHKey | null;
  setupCompleted: boolean;
}

const STORAGE_KEY = "falck.config";

const DEFAULT_CONFIG: AppConfig = {
  selectedSSHKey: null,
  setupCompleted: false,
};

function loadConfig(): AppConfig {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULT_CONFIG;
    }
    const parsed = JSON.parse(raw) as AppConfig;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function saveConfig(config: AppConfig) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export const configService = {
  getSelectedSSHKey(): SSHKey | null {
    return loadConfig().selectedSSHKey;
  },

  setSelectedSSHKey(key: SSHKey | null) {
    const config = loadConfig();
    config.selectedSSHKey = key;
    saveConfig(config);
  },

  getSetupCompleted(): boolean {
    return loadConfig().setupCompleted;
  },

  setSetupCompleted(value: boolean) {
    const config = loadConfig();
    config.setupCompleted = value;
    saveConfig(config);
  },
};
