import { invoke } from "@tauri-apps/api/core";

export interface Message {
  id?: string;
  role: "user" | "assistant";
  text: string;
  timestamp: string;
}

export interface AISession {
  path: string;
  name: string;
  model: string;
  created: string;
  repoPath?: string;
}

export interface Provider {
  name: string;
  models: string[];
}

export interface OpenCodeProviderListItem {
  id: string;
  name: string;
  env: string[];
  source?: "env" | "config" | "custom" | "api";
  modelCount: number;
}

export interface OpenCodeProviderList {
  all: OpenCodeProviderListItem[];
  default: Record<string, string>;
  connected: string[];
}

export type ProviderAuthMethod = {
  type: "oauth" | "api";
  label: string;
};

export type ProviderAuthResponse = Record<string, ProviderAuthMethod[]>;

export type ProviderAuthAuthorization = {
  url: string;
  method: "auto" | "code";
  instructions: string;
};

export interface OpenCodeProviderConfig {
  npm?: string;
  name?: string;
  env?: string[];
  options?: Record<string, unknown>;
  models?: Record<string, { name?: string; [key: string]: unknown }>;
}

export interface OpenCodeConfigData {
  provider?: Record<string, OpenCodeProviderConfig>;
  disabled_providers?: string[];
  enabled_providers?: string[];
  [key: string]: unknown;
}

export interface OpenCodeConfig {
  config: OpenCodeConfigData;
  providers: Provider[];
  defaults: Record<string, string>;
}

export interface OpenCodeStatus {
  installed: boolean;
  version?: string;
  path?: string;
}

export interface OpenCodeServerInfo {
  baseUrl: string;
  startedAt: number | null;
}

export type OpenCodeTextPartInput = {
  type: "text";
  text: string;
};

export type OpenCodeFilePartInput = {
  type: "file";
  mime: string;
  url: string;
  filename?: string;
  source?: {
    type: "file";
    path: string;
    text: {
      value: string;
      start: number;
      end: number;
    };
  };
};

export type OpenCodePartInput = OpenCodeTextPartInput | OpenCodeFilePartInput;

export interface OpenCodeInstallResult {
  success: boolean;
  message: string;
  requiresManualInstall?: boolean;
}

interface RetryOptions {
  maxRetries: number;
  delayMs: number;
  backoffMultiplier: number;
}

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  delayMs: 1000,
  backoffMultiplier: 2,
};

async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = DEFAULT_RETRY_OPTIONS,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      if (attempt < options.maxRetries) {
        const delay = options.delayMs * Math.pow(options.backoffMultiplier, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError ?? new Error("OpenCode request failed");
}

async function sendCommand(
  cmd: string,
  args: Record<string, unknown>,
  directory?: string,
) {
  const payload = directory ? { ...args, directory } : args;
  return invoke("opencode_send", { cmd, args: payload });
}

export const opencodeService = {
  async health(directory?: string): Promise<{ healthy: boolean; version: string }> {
    return withRetry(() => sendCommand("health", {}, directory)) as Promise<{
      healthy: boolean;
      version: string;
    }>;
  },

  async getServerInfo(): Promise<OpenCodeServerInfo> {
    return withRetry(() => sendCommand("serverInfo", {}, undefined)) as Promise<OpenCodeServerInfo>;
  },

  async getConfig(directory?: string): Promise<OpenCodeConfig> {
    return withRetry(() => sendCommand("config", {}, directory)) as Promise<OpenCodeConfig>;
  },

  async getProviders(directory?: string): Promise<{
    providers: Provider[];
    defaults: Record<string, string>;
  }> {
    return withRetry(() => sendCommand("getProviders", {}, directory)) as Promise<{
      providers: Provider[];
      defaults: Record<string, string>;
    }>;
  },

  async listProviderCatalog(directory?: string): Promise<OpenCodeProviderList> {
    return withRetry(() => sendCommand("providerList", {}, directory)) as Promise<OpenCodeProviderList>;
  },

  async getProviderAuth(directory?: string): Promise<ProviderAuthResponse> {
    return withRetry(() => sendCommand("providerAuth", {}, directory)) as Promise<ProviderAuthResponse>;
  },

  async authorizeProviderOAuth(
    providerID: string,
    method: number,
    directory?: string,
  ): Promise<ProviderAuthAuthorization> {
    return withRetry(() =>
      sendCommand("providerOauthAuthorize", { providerID, method }, directory),
    ) as Promise<ProviderAuthAuthorization>;
  },

  async callbackProviderOAuth(
    providerID: string,
    method: number,
    code?: string,
    directory?: string,
  ): Promise<{ success: boolean }> {
    return withRetry(() =>
      sendCommand("providerOauthCallback", { providerID, method, code }, directory),
    ) as Promise<{ success: boolean }>;
  },

  async createSession(
    name: string,
    description: string,
    model: string,
    repoPath: string,
  ): Promise<AISession> {
    const result = (await withRetry(() =>
      sendCommand("createSession", { name, description, model }, repoPath),
    )) as { session: AISession };

    return { ...result.session, repoPath };
  },

  async getSession(sessionPath: string, directory?: string): Promise<AISession> {
    const result = (await withRetry(() =>
      sendCommand("getSession", { sessionPath }, directory),
    )) as { session: AISession };

    return result.session;
  },

  async listSessions(directory?: string): Promise<AISession[]> {
    const result = (await withRetry(() =>
      sendCommand("listSessions", {}, directory),
    )) as { sessions: AISession[] };

    return result.sessions || [];
  },

  async sendPrompt(
    sessionPath: string,
    message: string,
    model?: string,
    messageId?: string,
    directory?: string,
    system?: string,
    parts?: OpenCodePartInput[],
  ): Promise<{
    messageId?: string;
    sessionId?: string;
    message: string;
    response: string;
    model: string;
    timestamp: string;
  }> {
    return withRetry(() =>
      sendCommand(
        "prompt",
        { sessionPath, message, model, messageID: messageId, system, parts },
        directory,
      ),
    ) as Promise<{
      messageId?: string;
      sessionId?: string;
      message: string;
      response: string;
      model: string;
      timestamp: string;
    }>;
  },

  async sendPromptAsync(
    sessionPath: string,
    message: string,
    model?: string,
    messageId?: string,
    directory?: string,
    system?: string,
    parts?: OpenCodePartInput[],
  ): Promise<{ queued: boolean; sessionId?: string }> {
    return withRetry(() =>
      sendCommand(
        "promptAsync",
        { sessionPath, message, model, messageID: messageId, system, parts },
        directory,
      ),
    ) as Promise<{ queued: boolean; sessionId?: string }>;
  },

  async findFiles(
    query: string,
    directory?: string,
    options?: { includeDirs?: boolean; limit?: number; type?: "file" | "directory" },
  ): Promise<string[]> {
    const dirs = options?.includeDirs ? "true" : "false";
    const result = (await withRetry(() =>
      sendCommand(
        "findFiles",
        {
          query,
          dirs,
          limit: options?.limit,
          type: options?.type,
        },
        directory,
      ),
    )) as string[] | { files?: string[] };

    if (Array.isArray(result)) {
      return result;
    }
    return result.files ?? [];
  },

  async listMessages(sessionPath: string, directory?: string): Promise<Message[]> {
    const result = (await withRetry(() =>
      sendCommand("listMessages", { sessionPath }, directory),
    )) as { messages: Message[] };

    return result.messages || [];
  },

  async deleteSession(sessionPath: string, directory?: string): Promise<boolean> {
    const result = (await withRetry(() =>
      sendCommand("deleteSession", { sessionPath }, directory),
    )) as { success: boolean };

    return result.success;
  },

  async setAuth(provider: string, apiKey: string, directory?: string): Promise<boolean> {
    const result = (await withRetry(() =>
      sendCommand("setAuth", { provider, apiKey }, directory),
    )) as { success: boolean };

    return result.success;
  },

  async removeAuth(providerID: string): Promise<boolean> {
    const result = (await withRetry(() =>
      sendCommand("removeAuth", { providerID }),
    )) as { success: boolean };

    return result.success;
  },

  async updateConfig(config: OpenCodeConfigData): Promise<unknown> {
    return withRetry(() => sendCommand("updateConfig", { config }, undefined));
  },

  async dispose(): Promise<unknown> {
    return withRetry(() => sendCommand("dispose", {}, undefined));
  },

  async checkInstalled(): Promise<OpenCodeStatus> {
    try {
      return await invoke<OpenCodeStatus>("check_opencode_installed");
    } catch (error) {
      console.error("Error checking OpenCode status:", error);
      return {
        installed: false,
        version: undefined,
        path: undefined,
      };
    }
  },

  async install(): Promise<OpenCodeInstallResult> {
    try {
      const result = await invoke<string>("install_opencode");
      return {
        success: true,
        message: result,
      };
    } catch (error) {
      const errorMsg = String(error);
      if (errorMsg === "windows_manual_install") {
        return {
          success: false,
          message: "Windows installation requires manual download.",
          requiresManualInstall: true,
        };
      }

      return {
        success: false,
        message: `Installation failed: ${errorMsg}`,
      };
    }
  },

  async openInstallDocs(): Promise<void> {
    return invoke<void>("open_browser_to_url", {
      url: "https://opencode.ai/docs/",
    });
  },

  async openWindowsInstaller(): Promise<void> {
    return invoke<void>("open_browser_to_url", {
      url: "https://github.com/opencode-ai/opencode/releases/latest",
    });
  },

  async commandExists(command: string): Promise<boolean> {
    try {
      return await invoke<boolean>("check_command_exists", { command });
    } catch {
      return false;
    }
  },
};
