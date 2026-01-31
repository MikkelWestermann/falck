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

export interface OpenCodeConfig {
  providers: Provider[];
  defaults: Record<string, string>;
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
    directory?: string,
  ): Promise<{
    message: string;
    response: string;
    model: string;
    timestamp: string;
  }> {
    return withRetry(() =>
      sendCommand("prompt", { sessionPath, message, model }, directory),
    ) as Promise<{
      message: string;
      response: string;
      model: string;
      timestamp: string;
    }>;
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
};
