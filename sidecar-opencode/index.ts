import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk/v2";
import { createInterface } from "node:readline";
import path from "node:path";

type RequestMessage = {
  cmd: string;
  sessionPath?: string;
  name?: string;
  description?: string;
  model?: string;
  message?: string;
  provider?: string;
  apiKey?: string;
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

try {
  const started = await createOpencode({
    hostname: "127.0.0.1",
    port: 4096,
    timeout: 10000,
  });
  baseUrl = started.server.url;
  client = createOpencodeClient({ baseUrl, directory: opencodeDirectory });
  serverClose = started.server.close;
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

function firstTextPart(parts: Array<{ type?: string; text?: string }> | undefined) {
  for (const part of parts ?? []) {
    if (part?.type === "text") {
      return part.text ?? "";
    }
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
  const { cmd, sessionPath, ...args } = request;

  try {
    console.error("[SIDECAR] request", cmd, { sessionPath, ...args });
    switch (cmd) {
      case "health":
        await handleHealth();
        break;
      case "config":
        await handleConfig();
        break;
      case "createSession":
        await handleCreateSession(args);
        break;
      case "getSession":
        await handleGetSession(sessionPath);
        break;
      case "listSessions":
        await handleListSessions();
        break;
      case "prompt":
        await handlePrompt(sessionPath, args);
        break;
      case "listMessages":
        await handleListMessages(sessionPath);
        break;
      case "deleteSession":
        await handleDeleteSession(sessionPath);
        break;
      case "setAuth":
        await handleSetAuth(args);
        break;
      case "getProviders":
        await handleGetProviders();
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

async function handleConfig() {
  const [configResult, providersResult] = await Promise.all([
    client.config.get(),
    client.config.providers(),
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

async function handleGetProviders() {
  const providers = unwrapData(await client.config.providers());
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

async function handleCreateSession({
  name,
  description,
  model,
}: RequestMessage) {
  const session = await client.session.create({
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

async function handleGetSession(sessionPath?: string) {
  if (!sessionPath) {
    sendError("sessionPath is required", "INVALID_ARGUMENT");
    return;
  }
  const data = unwrapData(await client.session.get({ sessionID: sessionPath }));
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

async function handleListSessions() {
  const sessions = unwrapData(await client.session.list());
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
  { message, model }: RequestMessage = {},
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
  const response = await client.session.prompt({
    sessionID: sessionPath,
    model: modelParts,
    parts: [{ type: "text", text: message ?? "" }],
  });
  const data = unwrapData(response);

  sendMessage({
    type: "success",
    cmd: "prompt",
    data: {
      message,
      response: firstTextPart(data.parts),
      model,
      timestamp: new Date().toISOString(),
    },
  });
}

async function handleListMessages(sessionPath?: string) {
  if (!sessionPath) {
    sendError("sessionPath is required", "INVALID_ARGUMENT");
    return;
  }
  const data = unwrapData(
    await client.session.messages({ sessionID: sessionPath }),
  );

  const messageList = (data || []).map((msg) => ({
    id: msg.info.id,
    role: msg.info.role,
    timestamp: msg.info.time?.created,
    text: firstTextPart(msg.parts),
  }));

  sendMessage({
    type: "success",
    cmd: "listMessages",
    data: {
      messages: messageList,
    },
  });
}

async function handleDeleteSession(sessionPath?: string) {
  if (!sessionPath) {
    sendError("sessionPath is required", "INVALID_ARGUMENT");
    return;
  }
  const success = unwrapData(
    await client.session.delete({ sessionID: sessionPath }),
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
