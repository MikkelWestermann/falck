import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";

type RequestMessage = {
  cmd: string;
  sessionPath?: string;
  directory?: string;
  messageID?: string;
  name?: string;
  description?: string;
  model?: string;
  message?: string;
  parts?: Array<unknown>;
  provider?: string;
  providerID?: string;
  apiKey?: string;
  method?: number;
  code?: string;
  config?: unknown;
  system?: string;
  query?: string;
  dirs?: "true" | "false";
  type?: "file" | "directory";
  limit?: number;
};

type ResponseMessage =
  | { type: "success"; cmd: string; data?: unknown }
  | { type: "error"; message: string; code?: string };

type UiProvider = {
  name: string;
  models: string[];
};

let serverClose: (() => void) | undefined;
let baseUrl = "http://127.0.0.1:4096";
const cwd = process.cwd();
const defaultDirectory = cwd.endsWith(`${path.sep}src-tauri`)
  ? path.dirname(cwd)
  : cwd;
const opencodeDirectory = process.env.OPENCODE_DIRECTORY || defaultDirectory;
let client = createOpencodeClient({ baseUrl, directory: opencodeDirectory });
let serverStartedAt: number | null = null;
const opencodeBinary = process.env.OPENCODE_CLI_PATH || "opencode";
const azureEnv = {
  AZURE_RESOURCE_NAME: Boolean(process.env.AZURE_RESOURCE_NAME),
  AZURE_COGNITIVE_SERVICES_RESOURCE_NAME: Boolean(
    process.env.AZURE_COGNITIVE_SERVICES_RESOURCE_NAME,
  ),
};

function resolvePort(value?: number) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const envPort = process.env.OPENCODE_PORT;
  if (!envPort) {
    return 0;
  }
  const parsed = Number.parseInt(envPort, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

type ServerOptions = {
  hostname?: string;
  port?: number;
  timeout?: number;
};

async function createOpencodeServer(options: ServerOptions = {}) {
  const hostname = options.hostname ?? "127.0.0.1";
  const port = resolvePort(options.port);
  const timeout = options.timeout ?? 10000;

  console.error("[SIDECAR] OpenCode env", azureEnv);
  console.error("[SIDECAR] Starting OpenCode server", { hostname, port });

  const args = ["serve", `--hostname=${hostname}`, `--port=${port}`];
  const proc = spawn(opencodeBinary, args, { env: { ...process.env } });

  const url = await new Promise<string>((resolve, reject) => {
    const id = setTimeout(() => {
      reject(
        new Error(`Timeout waiting for server to start after ${timeout}ms`),
      );
    }, timeout);

    let output = "";

    proc.stdout?.on("data", (chunk) => {
      output += chunk.toString();
      const lines = output.split("\n");
      for (const line of lines) {
        if (!line.startsWith("opencode server listening")) {
          continue;
        }
        const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
        if (!match) {
          reject(new Error(`Failed to parse server url from output: ${line}`));
          return;
        }
        clearTimeout(id);
        resolve(match[1]!);
        return;
      }
    });

    proc.stderr?.on("data", (chunk) => {
      output += chunk.toString();
    });

    proc.on("exit", (code) => {
      clearTimeout(id);
      let message = `Server exited with code ${code}`;
      if (output.trim()) {
        message += `\nServer output: ${output}`;
      }
      reject(new Error(message));
    });

    proc.on("error", (error) => {
      clearTimeout(id);
      reject(error);
    });
  });

  return {
    url,
    close() {
      proc.kill();
    },
  };
}

try {
  console.error("[SIDECAR] Using opencode binary", opencodeBinary);
  const started = await createOpencodeServer({
    hostname: "127.0.0.1",
    timeout: 10000,
  });
  baseUrl = started.url;
  client = createOpencodeClient({ baseUrl, directory: opencodeDirectory });
  serverClose = started.close;
  serverStartedAt = Date.now();
  console.error("[SIDECAR] OpenCode server started at", baseUrl);
  console.error("[SIDECAR] Using OpenCode directory", opencodeDirectory);
} catch (err) {
  console.error(
    "[SIDECAR] Failed to start server, using existing server:",
    err,
  );
}

console.error("[SIDECAR] OpenCode client initialized");

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

function sendMessage(message: ResponseMessage) {
  console.error("[SIDECAR] response", message.type, "cmd" in message ? message.cmd : "", message);
  console.log(JSON.stringify(message));
}

function sendError(message: string, code = "ERROR") {
  sendMessage({ type: "error", message, code });
}

function unwrapData<T>(result: unknown): T {
  if (result && typeof result === "object" && "error" in result) {
    const error = (result as {
      error?: { data?: { message?: string }; name?: string };
    }).error;
    if (error) {
      const details =
        error.data?.message ||
        error.name ||
        JSON.stringify(error) ||
        "OpenCode request failed";
      throw new Error(details);
    }
  }
  if (result && typeof result === "object" && "data" in result) {
    return (result as { data: T }).data;
  }
  return result as T;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function healthWithRetry() {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      return unwrapData(await client.global.health());
    } catch (err) {
      lastError = err;
      await delay(250);
    }
  }
  throw lastError;
}

type AnyPart = {
  type?: string;
  text?: string;
  prompt?: string;
  description?: string;
  synthetic?: boolean;
  ignored?: boolean;
  state?: { status?: string; output?: string };
};

function extractMessageText(
  parts: Array<AnyPart> | undefined,
  role?: "user" | "assistant",
) {
  if (!parts || parts.length === 0) {
    return "";
  }

  const textParts = parts.filter(
    (part) =>
      part?.type === "text" &&
      typeof part.text === "string" &&
      !part.synthetic &&
      !part.ignored,
  );
  if (textParts.length > 0) {
    if (role === "assistant") {
      return textParts[textParts.length - 1]!.text ?? "";
    }
    let longest = textParts[0]!;
    for (const part of textParts) {
      if ((part.text ?? "").length > (longest.text ?? "").length) {
        longest = part;
      }
    }
    return longest.text ?? "";
  }

  return "";
}

function toUiProviders(data: {
  providers: Array<{ id: string; name?: string; models?: Record<string, unknown> }>;
  default?: Record<string, string>;
}): { providers: UiProvider[]; defaults: Record<string, string> } {
  const providers = (data.providers || []).map((provider) => {
    const modelIds = Object.keys(provider.models ?? {});
    const models = modelIds.map((id) => `${provider.id}/${id}`);
    return {
      name: provider.name || provider.id,
      models,
    };
  });

  const defaults = Object.fromEntries(
    Object.entries(data.default ?? {}).map(([providerID, modelID]) => [
      providerID,
      `${providerID}/${modelID}`,
    ]),
  );

  return { providers, defaults };
}

rl.on("line", async (line) => {
  try {
    const request = JSON.parse(line) as RequestMessage;
    await handleCommand(request);
  } catch (err) {
    const error = err as Error;
    sendError(`Invalid JSON: ${error.message}`, "PARSE_ERROR");
  }
});

async function handleCommand(request: RequestMessage) {
  const { cmd, sessionPath, directory, ...args } = request;

  try {
    console.error("[SIDECAR] request", cmd, { sessionPath, directory, ...args });
    switch (cmd) {
      case "health":
        await handleHealth();
        break;
      case "serverInfo":
        handleServerInfo();
        break;
      case "config":
        await handleConfig(directory);
        break;
      case "createSession":
        await handleCreateSession(args, directory);
        break;
      case "getSession":
        await handleGetSession(sessionPath, directory);
        break;
      case "listSessions":
        await handleListSessions(directory);
        break;
      case "prompt":
        await handlePrompt(sessionPath, args, directory);
        break;
      case "promptAsync":
        await handlePromptAsync(sessionPath, args, directory);
        break;
      case "findFiles":
        await handleFindFiles(args, directory);
        break;
      case "listMessages":
        await handleListMessages(sessionPath, directory);
        break;
      case "deleteSession":
        await handleDeleteSession(sessionPath, directory);
        break;
      case "setAuth":
        await handleSetAuth(args);
        break;
      case "getProviders":
        await handleGetProviders(directory);
        break;
      case "providerList":
        await handleProviderList(directory);
        break;
      case "providerAuth":
        await handleProviderAuth(directory);
        break;
      case "providerOauthAuthorize":
        await handleProviderOauthAuthorize(args, directory);
        break;
      case "providerOauthCallback":
        await handleProviderOauthCallback(args, directory);
        break;
      case "removeAuth":
        await handleRemoveAuth(args);
        break;
      case "updateConfig":
        await handleUpdateConfig(args);
        break;
      case "dispose":
        await handleDispose();
        break;
      default:
        sendError(`Unknown command: ${cmd}`, "UNKNOWN_CMD");
    }
  } catch (err) {
    console.error("[SIDECAR] Error:", err);
    const error = err as Error & { code?: string };
    sendError(error.message || String(error), error.code || "UNKNOWN_ERROR");
  }
}

async function handleHealth() {
  const health = await healthWithRetry();
  sendMessage({
    type: "success",
    cmd: "health",
    data: {
      healthy: health.healthy,
      version: health.version,
    },
  });
}

function handleServerInfo() {
  sendMessage({
    type: "success",
    cmd: "serverInfo",
    data: {
      baseUrl,
      startedAt: serverStartedAt,
    },
  });
}

async function handleConfig(directory?: string) {
  const [configResult, providersResult] = await Promise.all([
    client.config.get({ directory }),
    client.config.providers({ directory }),
  ]);
  const config = unwrapData(configResult);
  const providers = unwrapData(providersResult);
  const uiProviders = toUiProviders(providers);

  sendMessage({
    type: "success",
    cmd: "config",
    data: {
      config,
      providers: uiProviders.providers,
      defaults: uiProviders.defaults,
    },
  });
}

async function handleGetProviders(directory?: string) {
  const providers = unwrapData(await client.config.providers({ directory }));
  const uiProviders = toUiProviders(providers);
  sendMessage({
    type: "success",
    cmd: "getProviders",
    data: {
      providers: uiProviders.providers,
      defaults: uiProviders.defaults,
    },
  });
}

async function handleProviderList(directory?: string) {
  const providers = unwrapData(await client.provider.list({ directory }));
  const summary = {
    all: (providers?.all ?? []).map((provider: any) => ({
      id: provider.id,
      name: provider.name ?? provider.id,
      env: provider.env ?? [],
      source: provider.source,
      modelCount: Object.keys(provider.models ?? {}).length,
    })),
    default: providers?.default ?? {},
    connected: providers?.connected ?? [],
  };
  sendMessage({
    type: "success",
    cmd: "providerList",
    data: summary,
  });
}

async function handleProviderAuth(directory?: string) {
  const methods = unwrapData(await client.provider.auth({ directory }));
  sendMessage({
    type: "success",
    cmd: "providerAuth",
    data: methods ?? {},
  });
}

async function handleProviderOauthAuthorize(
  { providerID, method }: RequestMessage,
  directory?: string,
) {
  if (!providerID || typeof method !== "number") {
    sendError("providerID and method are required", "INVALID_ARGUMENT");
    return;
  }
  const authorization = unwrapData(
    await client.provider.oauth.authorize({
      providerID,
      method,
      directory,
    }),
  );
  sendMessage({
    type: "success",
    cmd: "providerOauthAuthorize",
    data: authorization,
  });
}

async function handleProviderOauthCallback(
  { providerID, method, code }: RequestMessage,
  directory?: string,
) {
  if (!providerID || typeof method !== "number") {
    sendError("providerID and method are required", "INVALID_ARGUMENT");
    return;
  }
  const success = unwrapData(
    await client.provider.oauth.callback({
      providerID,
      method,
      code,
      directory,
    }),
  );
  sendMessage({
    type: "success",
    cmd: "providerOauthCallback",
    data: { success },
  });
}

async function handleRemoveAuth({ providerID }: RequestMessage) {
  if (!providerID) {
    sendError("providerID is required", "INVALID_ARGUMENT");
    return;
  }
  const success = unwrapData(await client.auth.remove({ providerID }));
  sendMessage({
    type: "success",
    cmd: "removeAuth",
    data: { success },
  });
}

async function handleUpdateConfig({ config }: RequestMessage) {
  if (!config || typeof config !== "object") {
    sendError("config is required", "INVALID_ARGUMENT");
    return;
  }
  const updated = unwrapData(
    await client.global.config.update({ config }),
  );
  sendMessage({
    type: "success",
    cmd: "updateConfig",
    data: updated,
  });
}

async function handleDispose() {
  const result = unwrapData(await client.global.dispose());
  sendMessage({
    type: "success",
    cmd: "dispose",
    data: result,
  });
}

async function handleCreateSession(
  { name, description }: RequestMessage,
  directory?: string,
) {
  const session = await client.session.create({
    directory,
    title: name || description || "Untitled Session",
  });
  const data = unwrapData(session);

  sendMessage({
    type: "success",
    cmd: "createSession",
    data: {
      sessionPath: data.id ?? data.path ?? data.slug,
      session: {
        path: data.path ?? data.id ?? data.slug,
        name: data.name ?? data.title,
        created: data.time?.created,
        model: data.model,
      },
    },
  });
}

async function handleGetSession(sessionPath?: string, directory?: string) {
  if (!sessionPath) {
    sendError("sessionPath is required", "INVALID_ARGUMENT");
    return;
  }
  const data = unwrapData(
    await client.session.get({ sessionID: sessionPath, directory }),
  );
  sendMessage({
    type: "success",
    cmd: "getSession",
    data: {
      session: {
        path: data.path ?? data.id ?? data.slug,
        name: data.name ?? data.title,
        model: data.model,
        created: data.time?.created,
      },
    },
  });
}

async function handleListSessions(directory?: string) {
  const sessions = unwrapData(await client.session.list({ directory }));
  const sessionList = (sessions || []).map((session) => ({
    path: session.path ?? session.id ?? session.slug,
    name: session.name ?? session.title,
    model: session.model,
    created: session.time?.created,
  }));

  sendMessage({
    type: "success",
    cmd: "listSessions",
    data: {
      sessions: sessionList,
    },
  });
}

async function handlePrompt(
  sessionPath?: string,
  { message, model, messageID, system, parts }: RequestMessage = {},
  directory?: string,
) {
  if (!sessionPath) {
    sendError("sessionPath is required", "INVALID_ARGUMENT");
    return;
  }
  const modelParts =
    typeof model === "string" && model.includes("/")
      ? {
          providerID: model.split("/")[0],
          modelID: model.split("/").slice(1).join("/"),
        }
      : undefined;
  const normalizedParts = Array.isArray(parts) ? parts.slice() : [];
  if (!normalizedParts.some((part) => part && typeof part === "object" && "type" in part)) {
    normalizedParts.length = 0;
  }
  if (!normalizedParts.some((part) => (part as { type?: string })?.type === "text")) {
    normalizedParts.unshift({ type: "text", text: message ?? "" });
  }

  const response = await client.session.prompt({
    sessionID: sessionPath,
    directory,
    messageID,
    model: modelParts,
    system,
    parts: normalizedParts,
  });
  const data = unwrapData(response);

  sendMessage({
    type: "success",
    cmd: "prompt",
    data: {
      messageId: data.info?.id,
      sessionId: data.info?.sessionID,
      message,
      response: extractMessageText(data.parts, "assistant"),
      model,
      timestamp: new Date().toISOString(),
    },
  });
}

async function handlePromptAsync(
  sessionPath?: string,
  { message, model, messageID, system, parts }: RequestMessage = {},
  directory?: string,
) {
  if (!sessionPath) {
    sendError("sessionPath is required", "INVALID_ARGUMENT");
    return;
  }
  const modelParts =
    typeof model === "string" && model.includes("/")
      ? {
          providerID: model.split("/")[0],
          modelID: model.split("/").slice(1).join("/"),
        }
      : undefined;

  const normalizedParts = Array.isArray(parts) ? parts.slice() : [];
  if (!normalizedParts.some((part) => part && typeof part === "object" && "type" in part)) {
    normalizedParts.length = 0;
  }
  if (!normalizedParts.some((part) => (part as { type?: string })?.type === "text")) {
    normalizedParts.unshift({ type: "text", text: message ?? "" });
  }

  await client.session.promptAsync({
    sessionID: sessionPath,
    directory,
    messageID,
    model: modelParts,
    system,
    parts: normalizedParts,
  });

  sendMessage({
    type: "success",
    cmd: "promptAsync",
    data: {
      queued: true,
      sessionId: sessionPath,
    },
  });
}

async function handleFindFiles(
  { query, dirs, type, limit }: RequestMessage = {},
  directory?: string,
) {
  const trimmed = typeof query === "string" ? query.trim() : "";
  const data = unwrapData(
    await client.find.files({
      directory,
      query: trimmed,
      dirs,
      type,
      limit,
    }),
  );

  sendMessage({
    type: "success",
    cmd: "findFiles",
    data,
  });
}

async function handleListMessages(sessionPath?: string, directory?: string) {
  if (!sessionPath) {
    sendError("sessionPath is required", "INVALID_ARGUMENT");
    return;
  }
  const data = unwrapData(
    await client.session.messages({ sessionID: sessionPath, directory }),
  );

  const messageList = (data || []).map((msg) => ({
    id: msg.info.id,
    role: msg.info.role,
    timestamp: msg.info.time?.created
      ? new Date(msg.info.time.created).toISOString()
      : new Date().toISOString(),
    text: extractMessageText(msg.parts, msg.info.role),
  }));

  sendMessage({
    type: "success",
    cmd: "listMessages",
    data: {
      messages: messageList,
    },
  });
}

async function handleDeleteSession(sessionPath?: string, directory?: string) {
  if (!sessionPath) {
    sendError("sessionPath is required", "INVALID_ARGUMENT");
    return;
  }
  const success = unwrapData(
    await client.session.delete({ sessionID: sessionPath, directory }),
  );
  sendMessage({
    type: "success",
    cmd: "deleteSession",
    data: {
      success,
      sessionPath,
    },
  });
}

async function handleSetAuth({ provider, apiKey }: RequestMessage) {
  if (!provider || !apiKey) {
    sendError("provider and apiKey are required", "INVALID_ARGUMENT");
    return;
  }
  const success = unwrapData(
    await client.auth.set({
      providerID: provider,
      auth: { type: "api", key: apiKey },
    }),
  );

  sendMessage({
    type: "success",
    cmd: "setAuth",
    data: {
      success,
      provider,
    },
  });
}

setInterval(async () => {
  try {
    await client.global.health();
  } catch (err) {
    console.error("[SIDECAR] Health check failed:", err);
  }
}, 30000);

process.on("SIGTERM", () => {
  console.error("[SIDECAR] Received SIGTERM, shutting down gracefully");
  serverClose?.();
  process.exit(0);
});

process.on("SIGINT", () => {
  console.error("[SIDECAR] Received SIGINT, shutting down gracefully");
  serverClose?.();
  process.exit(0);
});

console.error("[SIDECAR] Ready to receive commands on stdin");
