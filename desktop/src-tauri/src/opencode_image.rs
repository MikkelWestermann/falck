use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager, Runtime};

use crate::blocking::run_blocking;
use crate::falck::load_shell_env;
use crate::storage::{
    clear_opencode_image_azure_api_key, clear_opencode_image_openai_api_key,
    get_opencode_image_azure_api_key, get_opencode_image_openai_api_key,
    get_opencode_image_settings as get_stored_opencode_image_settings,
    set_opencode_image_azure_api_key, set_opencode_image_openai_api_key,
    set_opencode_image_settings as set_stored_opencode_image_settings, StoredOpencodeImageSettings,
};

const TOOL_FILENAME: &str = "falck_generate_image.ts";
const PLACE_TOOL_FILENAME: &str = "falck_place_image.ts";
const DEFAULT_AZURE_API_VERSION: &str = "2025-04-01-preview";
const GPT_IMAGE_MODEL: &str = "gpt-image-1.5";

const FALCK_IMAGE_TOOL_SOURCE: &str = r#"import { tool } from "@opencode-ai/plugin";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const OPENAI_MODEL = "gpt-image-1.5";
const OPENAI_URL = "https://api.openai.com/v1/images/generations";
const AZURE_API_VERSION =
  process.env.FALCK_OPENCODE_IMAGE_AZURE_API_VERSION ?? "2025-04-01-preview";
const REQUEST_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(
    process.env.FALCK_OPENCODE_IMAGE_TIMEOUT_MS ?? "120000",
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120000;
})();
const LOG_DIR = path.join(os.tmpdir(), "falck-gpt-image-logs");

function trimToNull(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extensionFor(format) {
  if (format === "jpeg") {
    return "jpg";
  }
  return format;
}

function createRunContext(toolName) {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const logFile = path.join(LOG_DIR, `${toolName}-${runId}.log`);

  async function log(level, message, details = undefined) {
    const entry = {
      time: new Date().toISOString(),
      level,
      message,
      details: sanitizeLogDetails(details),
    };

    console.error(`[${toolName}] ${message}`, entry.details ?? "");
    try {
      await fs.mkdir(LOG_DIR, { recursive: true });
      await fs.appendFile(logFile, `${JSON.stringify(entry)}\n`, "utf8");
    } catch (error) {
      console.error(`[${toolName}] Failed to write debug log`, error);
    }
  }

  return {
    runId,
    logFile,
    log,
  };
}

function sanitizeLogDetails(details) {
  if (!details || typeof details !== "object") {
    return details ?? null;
  }
  const value = Array.isArray(details) ? [...details] : { ...details };
  if ("apiKey" in value) {
    value.apiKey = "[redacted]";
  }
  if ("headers" in value) {
    delete value.headers;
  }
  return value;
}

function toErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function errorWithLog(message, context) {
  if (message.includes(context.logFile)) {
    return new Error(message);
  }
  return new Error(`${message} Debug log: ${context.logFile}`);
}

function summarizeRequest(body) {
  return {
    promptPreview:
      typeof body?.prompt === "string" ? body.prompt.slice(0, 160) : null,
    size: body?.size ?? null,
    quality: body?.quality ?? null,
    background: body?.background ?? null,
    outputFormat: body?.output_format ?? null,
    n: body?.n ?? null,
  };
}

function summarizePayload(payload, fallbackText) {
  return {
    imageCount: Array.isArray(payload?.data) ? payload.data.length : 0,
    error: payload?.error?.message ?? payload?.message ?? null,
    textPreview:
      typeof fallbackText === "string" && fallbackText.length > 0
        ? fallbackText.slice(0, 500)
        : null,
  };
}

function resolveOpenAIKey() {
  return trimToNull(
    process.env.FALCK_OPENCODE_IMAGE_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
  );
}

function resolveAzureKey() {
  return trimToNull(
    process.env.FALCK_OPENCODE_IMAGE_AZURE_API_KEY ??
      process.env.AZURE_OPENAI_API_KEY ??
      process.env.AZURE_OPENAI_KEY,
  );
}

function resolveAzureEndpoint() {
  const explicit = trimToNull(
    process.env.FALCK_OPENCODE_IMAGE_AZURE_ENDPOINT ??
      process.env.AZURE_OPENAI_ENDPOINT,
  );
  if (explicit) {
    return explicit.replace(/\/+$/, "");
  }

  const resourceName = trimToNull(
    process.env.AZURE_RESOURCE_NAME ??
      process.env.AZURE_COGNITIVE_SERVICES_RESOURCE_NAME,
  );
  if (!resourceName) {
    return null;
  }
  return `https://${resourceName}.openai.azure.com`;
}

function resolveAzureDeployment() {
  return trimToNull(
    process.env.FALCK_OPENCODE_IMAGE_AZURE_DEPLOYMENT ??
      process.env.AZURE_OPENAI_IMAGE_DEPLOYMENT ??
      process.env.AZURE_OPENAI_DEPLOYMENT ??
      process.env.AZURE_DEPLOYMENT_NAME,
  );
}

function resolveDefaultProvider() {
  const provider = trimToNull(
    process.env.FALCK_OPENCODE_IMAGE_DEFAULT_PROVIDER,
  )?.toLowerCase();
  return provider === "azure" ? "azure" : "openai";
}

function configuredProviders() {
  const providers = [];
  if (resolveOpenAIKey()) {
    providers.push("openai");
  }
  if (resolveAzureKey() && resolveAzureEndpoint() && resolveAzureDeployment()) {
    providers.push("azure");
  }
  return providers;
}

function formatProviderList(providers) {
  if (!Array.isArray(providers) || providers.length === 0) {
    return "none";
  }
  return providers.join(", ");
}

function resolveProvider(requested) {
  if (requested && requested !== "openai" && requested !== "azure") {
    throw new Error(`Unsupported provider: ${requested}`);
  }

  const available = configuredProviders();
  if (available.length === 0) {
    throw new Error(
      "No image provider is configured. Connect OpenAI or Azure in OpenCode, add Falck image overrides, or export the matching environment variables.",
    );
  }

  if (requested) {
    if (!available.includes(requested)) {
      throw new Error(
        `The ${requested} image provider is not configured for image generation. Available providers: ${formatProviderList(available)}. Omit provider to use the configured provider automatically, or configure ${requested} in OpenCode/Falck image settings.`,
      );
    }
    return requested;
  }

  const preferred = resolveDefaultProvider();
  if (available.includes(preferred)) {
    return preferred;
  }
  return available[0];
}

function slugifyPrompt(value) {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 40) || "image";
}

function extractBase64(entry) {
  if (entry && typeof entry === "object") {
    if (typeof entry.b64_json === "string" && entry.b64_json.length > 0) {
      return entry.b64_json;
    }
    if (typeof entry.b64Json === "string" && entry.b64Json.length > 0) {
      return entry.b64Json;
    }
    const url = entry.url ?? entry.image_url;
    if (typeof url === "string" && url.startsWith("data:")) {
      const separator = url.indexOf(",");
      if (separator >= 0) {
        return url.slice(separator + 1);
      }
    }
  }
  return null;
}

function resolveOutputPath(outputPath, format) {
  const trimmed = trimToNull(outputPath);
  if (!trimmed) {
    return null;
  }

  const base = path.isAbsolute(trimmed)
    ? path.normalize(trimmed)
    : path.join(process.cwd(), trimmed);
  if (base.endsWith(path.sep)) {
    throw new Error(
      "outputPath must be a file path, not a directory. Example: apps/site/public/hero.png",
    );
  }
  if (path.extname(base)) {
    return base;
  }
  return `${base}.${extensionFor(format)}`;
}

async function ensureDestination(filepath, overwrite) {
  await fs.mkdir(path.dirname(filepath), { recursive: true });
  if (overwrite) {
    return;
  }

  try {
    await fs.access(filepath);
    throw new Error(
      `Destination already exists: ${filepath}. Pass overwrite: true to replace it.`,
    );
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function postJson(url, body, headers, context) {
  await context.log("info", "Starting image request", {
    url,
    timeoutMs: REQUEST_TIMEOUT_MS,
    request: summarizeRequest(body),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      await context.log("error", "Image API request failed", {
        url,
        status: response.status,
        statusText: response.statusText,
        response: summarizePayload(payload, text),
      });
      const message =
        payload?.error?.message ??
        payload?.message ??
        `${response.status} ${response.statusText}`;
      throw errorWithLog(message, context);
    }

    await context.log("info", "Image request completed", {
      url,
      status: response.status,
      response: summarizePayload(payload, text),
    });
    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      await context.log("error", "Image request timed out", {
        url,
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      throw errorWithLog(
        `Image generation timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)} seconds.`,
        context,
      );
    }

    await context.log("error", "Image request threw", {
      url,
      message: toErrorMessage(error),
    });
    throw errorWithLog(toErrorMessage(error), context);
  } finally {
    clearTimeout(timer);
  }
}

async function requestOpenAI(body, context) {
  const apiKey = resolveOpenAIKey();
  if (!apiKey) {
    throw new Error(
      "OpenAI image generation is not configured. Connect OpenAI in OpenCode, add a Falck override key, or export OPENAI_API_KEY.",
    );
  }

  return postJson(
    OPENAI_URL,
    { model: OPENAI_MODEL, ...body },
    {
      Authorization: `Bearer ${apiKey}`,
    },
    context,
  );
}

async function requestAzure(body, context) {
  const apiKey = resolveAzureKey();
  const endpoint = resolveAzureEndpoint();
  const deployment = resolveAzureDeployment();
  if (!apiKey || !endpoint || !deployment) {
    throw new Error(
      "Azure image generation requires an API key, endpoint/resource, and image deployment. Falck reuses OpenCode Azure auth and config when available, but you may still need to set an image deployment override.",
    );
  }

  const url =
    `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}` +
    `/images/generations?api-version=${encodeURIComponent(AZURE_API_VERSION)}`;

  return postJson(
    url,
    body,
    {
      "api-key": apiKey,
    },
    context,
  );
}

async function saveImages(
  response,
  { prompt, format, outputPath, overwrite, n },
  context,
) {
  const requestedOutputPath = resolveOutputPath(outputPath, format);
  const entries = Array.isArray(response?.data) ? response.data : [];
  const saved = [];
  const baseName = slugifyPrompt(prompt);
  const extension = extensionFor(format);

  if (requestedOutputPath && Number(n) !== 1) {
    throw new Error(
      "outputPath can only be used when n is 1. Omit outputPath for temp output, or generate a single image.",
    );
  }

  if (requestedOutputPath) {
    const payload = extractBase64(entries[0]);
    if (!payload) {
      throw new Error("The image API returned no image data.");
    }

    await ensureDestination(requestedOutputPath, overwrite);
    await fs.writeFile(requestedOutputPath, Buffer.from(payload, "base64"));
    await context.log("info", "Saved generated image directly", {
      outputPath: requestedOutputPath,
      overwrite,
    });

    saved.push({
      path: requestedOutputPath,
      filename: path.basename(requestedOutputPath),
      format,
    });

    return {
      directory: path.dirname(requestedOutputPath),
      files: saved,
      savedTo: "direct",
    };
  }

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "falck-gpt-image-"));
  for (let index = 0; index < entries.length; index += 1) {
    const payload = extractBase64(entries[index]);
    if (!payload) {
      await context.log("warning", "Skipping image entry with no file payload", {
        index,
      });
      continue;
    }

    const filename = `${baseName}-${String(index + 1).padStart(2, "0")}.${extension}`;
    const filepath = path.join(directory, filename);
    await fs.writeFile(filepath, Buffer.from(payload, "base64"));
    saved.push({
      path: filepath,
      filename,
      format,
    });
  }

  if (saved.length === 0) {
    throw new Error("The image API returned no image data.");
  }

  await context.log("info", "Saved generated images to temp directory", {
    directory,
    imageCount: saved.length,
  });

  return {
    directory,
    files: saved,
    savedTo: "temp",
  };
}

function formatToolResult(result) {
  return JSON.stringify(result, null, 2);
}

export default tool({
  description: [
    "Generate one or more images with GPT Image 1.5 using OpenAI or Azure.",
    "Always call this tool with an object, not a raw string.",
    'Minimum valid call: { "prompt": "..." }.',
    'Wide hero example: { "prompt": "...", "size": "1536x1024", "quality": "high", "format": "png" }.',
    'Direct-save example: { "prompt": "...", "outputPath": "apps/site/public/hero.png", "overwrite": true }.',
    "If you already know the final repo file path, pass outputPath to save directly there.",
    "If you omit outputPath, the image is saved to a temp directory and can be moved later with falck_place_image.",
  ].join(" "),
  args: {
    prompt: tool.schema
      .string()
      .min(1)
      .max(4000)
      .describe("Required image prompt string."),
    provider: tool.schema
      .enum(["openai", "azure"])
      .optional()
      .describe("Optional provider override. Omit this to reuse the default configured OpenCode/Falck image provider."),
    size: tool.schema
      .enum(["1024x1024", "1536x1024", "1024x1536"])
      .default("1024x1024")
      .optional()
      .describe("Image size. Use 1536x1024 for wide hero images."),
    quality: tool.schema
      .enum(["auto", "low", "medium", "high"])
      .default("auto")
      .optional()
      .describe("Rendering quality."),
    background: tool.schema
      .enum(["auto", "transparent", "opaque"])
      .default("auto")
      .optional()
      .describe("Background fill mode."),
    format: tool.schema
      .enum(["png", "jpeg", "webp"])
      .default("png")
      .optional()
      .describe("Output image format."),
    n: tool.schema
      .number()
      .min(1)
      .max(10)
      .default(1)
      .optional()
      .describe("Number of images to generate."),
    outputPath: tool.schema
      .string()
      .optional()
      .describe("Optional final file path. Relative paths are resolved from the repo root. Example: apps/site/public/hero.png. Only use this when n is 1."),
    overwrite: tool.schema
      .boolean()
      .default(false)
      .optional()
      .describe("Set to true to replace an existing file when outputPath is used."),
  },
  async execute(
    {
      prompt,
      provider,
      size = "1024x1024",
      quality = "auto",
      background = "auto",
      format = "png",
      n = 1,
      outputPath,
      overwrite = false,
    },
    toolContext,
  ) {
    const context = createRunContext("falck_generate_image");
    try {
      const selectedProvider = resolveProvider(provider);
      const request = {
        prompt,
        size,
        quality,
        background,
        output_format: format,
        n,
      };

      await context.log("info", "Resolved image generation request", {
        provider: selectedProvider,
        outputPath: resolveOutputPath(outputPath, format),
        overwrite,
        request: summarizeRequest(request),
      });

      const response =
        selectedProvider === "azure"
          ? await requestAzure(request, context)
          : await requestOpenAI(request, context);
      const saved = await saveImages(
        response,
        { prompt, format, outputPath, overwrite, n },
        context,
      );
      const result = {
        provider: selectedProvider,
        model:
          selectedProvider === "azure"
            ? resolveAzureDeployment() ?? OPENAI_MODEL
            : OPENAI_MODEL,
        savedTo: saved.savedTo,
        tempDirectory: saved.savedTo === "temp" ? saved.directory : null,
        outputDirectory: saved.directory,
        images: saved.files,
        logFile: context.logFile,
        placementTool: saved.savedTo === "temp" ? "falck_place_image" : null,
        placementArgsTemplate:
          saved.savedTo === "temp" && saved.files[0]
            ? {
                sourcePath: saved.files[0].path,
                destinationPath: "<final repo file path>",
                mode: "move",
                overwrite: false,
              }
            : null,
        instructions:
          saved.savedTo === "direct"
            ? "The generated image was saved directly to the requested file path."
            : "The generated images are stored in a temporary directory. Replace destinationPath in placementArgsTemplate and call falck_place_image instead of using Bash.",
      };

      toolContext.metadata({
        title:
          saved.savedTo === "direct"
            ? "Generated image"
            : `Generated ${saved.files.length} image${saved.files.length === 1 ? "" : "s"}`,
        metadata: result,
      });

      return formatToolResult(result);
    } catch (error) {
      await context.log("error", "Image generation failed", {
        message: toErrorMessage(error),
      });
      toolContext.metadata({
        title: "Image generation failed",
        metadata: {
          logFile: context.logFile,
        },
      });
      throw errorWithLog(toErrorMessage(error), context);
    }
  },
});
"#;

const FALCK_PLACE_IMAGE_TOOL_SOURCE: &str = r#"import { tool } from "@opencode-ai/plugin";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const LOG_DIR = path.join(os.tmpdir(), "falck-gpt-image-logs");

function trimToNull(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function createRunContext(toolName) {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const logFile = path.join(LOG_DIR, `${toolName}-${runId}.log`);

  async function log(level, message, details = undefined) {
    const entry = {
      time: new Date().toISOString(),
      level,
      message,
      details: details ?? null,
    };

    console.error(`[${toolName}] ${message}`, entry.details ?? "");
    try {
      await fs.mkdir(LOG_DIR, { recursive: true });
      await fs.appendFile(logFile, `${JSON.stringify(entry)}\n`, "utf8");
    } catch (error) {
      console.error(`[${toolName}] Failed to write debug log`, error);
    }
  }

  return {
    runId,
    logFile,
    log,
  };
}

function toErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function errorWithLog(message, context) {
  if (message.includes(context.logFile)) {
    return new Error(message);
  }
  return new Error(`${message} Debug log: ${context.logFile}`);
}

function resolvePath(input, label) {
  const trimmed = trimToNull(input);
  if (!trimmed) {
    throw new Error(`${label} is required.`);
  }
  return path.isAbsolute(trimmed)
    ? path.normalize(trimmed)
    : path.join(process.cwd(), trimmed);
}

function resolveDestinationPath(destinationPath, sourcePath) {
  const resolved = resolvePath(destinationPath, "destinationPath");
  if (resolved.endsWith(path.sep)) {
    throw new Error(
      "destinationPath must be a file path, not a directory. Example: apps/site/public/hero.png",
    );
  }
  if (path.extname(resolved)) {
    return resolved;
  }
  const sourceExtension = path.extname(sourcePath);
  return sourceExtension ? `${resolved}${sourceExtension}` : resolved;
}

function formatFromPath(filepath) {
  const extension = path.extname(filepath).toLowerCase().replace(/^\./, "");
  if (extension === "jpg") {
    return "jpeg";
  }
  return extension || undefined;
}

async function ensureDestination(filepath, overwrite) {
  await fs.mkdir(path.dirname(filepath), { recursive: true });
  if (overwrite) {
    return;
  }

  try {
    await fs.access(filepath);
    throw new Error(
      `Destination already exists: ${filepath}. Pass overwrite: true to replace it.`,
    );
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function moveFile(sourcePath, destinationPath) {
  try {
    await fs.rename(sourcePath, destinationPath);
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "EXDEV")) {
      throw error;
    }
    await fs.copyFile(sourcePath, destinationPath);
    await fs.unlink(sourcePath);
  }
}

export default tool({
  description: [
    "Move or copy a generated image into the repository without using Bash.",
    "Always call this tool with an object.",
    'Minimum valid call: { "sourcePath": "...", "destinationPath": "..." }.',
    'Example: { "sourcePath": "/tmp/falck-gpt-image-123/hero-01.png", "destinationPath": "apps/site/public/hero.png", "mode": "move" }.',
    "destinationPath may be relative to the repo root or absolute.",
  ].join(" "),
  args: {
    sourcePath: tool.schema
      .string()
      .min(1)
      .describe("Required source image path, usually returned by falck_generate_image."),
    destinationPath: tool.schema
      .string()
      .min(1)
      .describe("Required final file path. Relative paths are resolved from the repo root."),
    mode: tool.schema
      .enum(["move", "copy"])
      .default("move")
      .optional()
      .describe("Use move by default. Use copy if you want to keep the source image too."),
    overwrite: tool.schema
      .boolean()
      .default(false)
      .optional()
      .describe("Set to true to replace an existing file at the destination."),
  },
  async execute(
    {
      sourcePath,
      destinationPath,
      mode = "move",
      overwrite = false,
    },
    toolContext,
  ) {
    const context = createRunContext("falck_place_image");
    try {
      const resolvedSourcePath = resolvePath(sourcePath, "sourcePath");
      const resolvedDestinationPath = resolveDestinationPath(
        destinationPath,
        resolvedSourcePath,
      );

      await context.log("info", "Starting image placement", {
        sourcePath: resolvedSourcePath,
        destinationPath: resolvedDestinationPath,
        mode,
        overwrite,
      });

      const sourceStats = await fs.stat(resolvedSourcePath);
      if (!sourceStats.isFile()) {
        throw new Error(`Source path is not a file: ${resolvedSourcePath}`);
      }

      await ensureDestination(resolvedDestinationPath, overwrite);
      if (mode === "copy") {
        await fs.copyFile(resolvedSourcePath, resolvedDestinationPath);
      } else {
        await moveFile(resolvedSourcePath, resolvedDestinationPath);
      }

      await context.log("info", "Placed image", {
        sourcePath: resolvedSourcePath,
        destinationPath: resolvedDestinationPath,
        mode,
      });
      const result = {
        operation: mode,
        sourcePath: resolvedSourcePath,
        destinationPath: resolvedDestinationPath,
        directory: path.dirname(resolvedDestinationPath),
        images: [
          {
            path: resolvedDestinationPath,
            filename: path.basename(resolvedDestinationPath),
            format: formatFromPath(resolvedDestinationPath),
          },
        ],
        logFile: context.logFile,
        instructions:
          mode === "copy"
            ? "The destination file is ready in the repository. The original source file was kept."
            : "The destination file is ready in the repository. The original source file was moved.",
      };

      toolContext.metadata({
        title: mode === "copy" ? "Copied image" : "Moved image",
        metadata: result,
      });

      return formatToolResult(result);
    } catch (error) {
      await context.log("error", "Image placement failed", {
        message: toErrorMessage(error),
      });
      toolContext.metadata({
        title: "Image placement failed",
        metadata: {
          logFile: context.logFile,
        },
      });
      throw errorWithLog(toErrorMessage(error), context);
    }
  },
});
"#;

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ImageProvider {
    Openai,
    Azure,
}

impl ImageProvider {
    fn as_str(self) -> &'static str {
        match self {
            Self::Openai => "openai",
            Self::Azure => "azure",
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeImageProviderStatus {
    pub has_stored_api_key: bool,
    pub has_env_api_key: bool,
    pub has_opencode_api_key: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeAzureImageSettings {
    pub override_endpoint: String,
    pub resolved_endpoint: String,
    pub override_deployment_name: String,
    pub resolved_deployment_name: String,
    pub has_stored_api_key: bool,
    pub has_env_api_key: bool,
    pub has_opencode_api_key: bool,
    pub has_opencode_endpoint: bool,
    pub has_opencode_deployment_name: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeImageSettings {
    pub global_dir: String,
    pub tool_path: String,
    pub tool_installed: bool,
    pub default_provider: Option<ImageProvider>,
    pub openai: OpenCodeImageProviderStatus,
    pub azure: OpenCodeAzureImageSettings,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveOpenCodeImageSettingsRequest {
    pub default_provider: Option<ImageProvider>,
    pub openai_api_key: Option<String>,
    #[serde(default)]
    pub clear_openai_api_key: bool,
    pub azure_api_key: Option<String>,
    #[serde(default)]
    pub clear_azure_api_key: bool,
    pub azure_endpoint: Option<String>,
    pub azure_deployment_name: Option<String>,
}

#[derive(Debug, Default, Clone)]
struct ImageEnvSnapshot {
    openai_api_key: Option<String>,
    azure_api_key: Option<String>,
    azure_endpoint: Option<String>,
    azure_deployment_name: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct OpenCodeAuthEntry {
    #[serde(default)]
    r#type: Option<String>,
    #[serde(default)]
    key: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct OpenCodeConfigFile {
    provider: HashMap<String, OpenCodeProviderConfigFile>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct OpenCodeProviderConfigFile {
    options: OpenCodeProviderOptions,
    models: HashMap<String, OpenCodeModelConfigFile>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct OpenCodeProviderOptions {
    resource_name: Option<String>,
    endpoint: Option<String>,
    base_url: Option<String>,
    deployment_name: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct OpenCodeModelConfigFile {
    name: Option<String>,
    model: Option<String>,
}

#[derive(Debug, Default, Clone)]
struct OpenCodeAuthSnapshot {
    openai_api_key: Option<String>,
    azure_api_key: Option<String>,
}

#[derive(Debug, Default, Clone)]
struct OpenCodeConfigSnapshot {
    azure_endpoint: Option<String>,
    azure_deployment_name: Option<String>,
}

#[derive(Debug, Default, Clone)]
struct ImageSourceSnapshot {
    env: ImageEnvSnapshot,
    opencode_auth: OpenCodeAuthSnapshot,
    opencode_config: OpenCodeConfigSnapshot,
}

#[derive(Debug, Default)]
struct EffectiveImageConfig {
    openai_api_key: Option<String>,
    azure_api_key: Option<String>,
    azure_endpoint: Option<String>,
    azure_deployment_name: Option<String>,
}

#[tauri::command]
pub async fn get_opencode_image_settings(app: AppHandle) -> Result<OpenCodeImageSettings, String> {
    run_blocking(move || {
        ensure_tool_installed(&app)?;
        build_settings_response(&app)
    })
    .await
}

#[tauri::command]
pub async fn save_opencode_image_settings(
    app: AppHandle,
    request: SaveOpenCodeImageSettingsRequest,
) -> Result<OpenCodeImageSettings, String> {
    run_blocking(move || {
        persist_settings(&app, request)?;
        ensure_tool_installed(&app)?;
        crate::opencode::reset_sidecar(&app)?;
        build_settings_response(&app)
    })
    .await
}

pub fn apply_sidecar_image_env<R: Runtime>(
    app: &AppHandle<R>,
    cmd: &mut Command,
) -> Result<(), String> {
    let stored = get_stored_opencode_image_settings(app)?;
    let stored_openai_key = get_opencode_image_openai_api_key(app)?;
    let stored_azure_key = get_opencode_image_azure_api_key(app)?;
    let sources = image_source_snapshot(app)?;
    let effective = resolve_effective_image_config(
        &stored,
        stored_openai_key.as_deref(),
        stored_azure_key.as_deref(),
        &sources,
    );

    if let Some(default_provider) = parse_provider(stored.default_provider.as_deref()) {
        cmd.env(
            "FALCK_OPENCODE_IMAGE_DEFAULT_PROVIDER",
            default_provider.as_str(),
        );
    }

    if let Some(openai_key) = effective.openai_api_key {
        cmd.env("FALCK_OPENCODE_IMAGE_OPENAI_API_KEY", openai_key);
    }

    if let Some(azure_key) = effective.azure_api_key {
        cmd.env("FALCK_OPENCODE_IMAGE_AZURE_API_KEY", azure_key);
    }

    if let Some(endpoint) = effective.azure_endpoint {
        cmd.env("FALCK_OPENCODE_IMAGE_AZURE_ENDPOINT", endpoint);
    }

    if let Some(deployment) = effective.azure_deployment_name {
        cmd.env("FALCK_OPENCODE_IMAGE_AZURE_DEPLOYMENT", deployment);
    }

    cmd.env(
        "FALCK_OPENCODE_IMAGE_AZURE_API_VERSION",
        DEFAULT_AZURE_API_VERSION,
    );

    Ok(())
}

pub fn ensure_tool_installed<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let tool_path = tool_path(app)?;
    if let Some(parent) = tool_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&tool_path, FALCK_IMAGE_TOOL_SOURCE).map_err(|e| e.to_string())?;
    let place_tool_path = place_tool_path(app)?;
    fs::write(&place_tool_path, FALCK_PLACE_IMAGE_TOOL_SOURCE).map_err(|e| e.to_string())?;
    Ok(tool_path)
}

fn build_settings_response<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<OpenCodeImageSettings, String> {
    let tool_path = tool_path(app)?;
    let stored = get_stored_opencode_image_settings(app)?;
    let stored_openai_key = get_opencode_image_openai_api_key(app)?;
    let stored_azure_key = get_opencode_image_azure_api_key(app)?;
    let sources = image_source_snapshot(app)?;
    let effective = resolve_effective_image_config(
        &stored,
        stored_openai_key.as_deref(),
        stored_azure_key.as_deref(),
        &sources,
    );
    let override_endpoint =
        normalize_optional(stored.azure_endpoint.as_deref()).unwrap_or_default();
    let override_deployment_name =
        normalize_optional(stored.azure_deployment_name.as_deref()).unwrap_or_default();

    Ok(OpenCodeImageSettings {
        global_dir: global_opencode_dir(app)?.to_string_lossy().to_string(),
        tool_path: tool_path.to_string_lossy().to_string(),
        tool_installed: tool_path.exists() && place_tool_path(app)?.exists(),
        default_provider: parse_provider(stored.default_provider.as_deref()),
        openai: OpenCodeImageProviderStatus {
            has_stored_api_key: stored_openai_key.is_some(),
            has_env_api_key: sources.env.openai_api_key.is_some(),
            has_opencode_api_key: sources.opencode_auth.openai_api_key.is_some(),
        },
        azure: OpenCodeAzureImageSettings {
            override_endpoint,
            resolved_endpoint: effective.azure_endpoint.unwrap_or_default(),
            override_deployment_name,
            resolved_deployment_name: effective.azure_deployment_name.unwrap_or_default(),
            has_stored_api_key: stored_azure_key.is_some(),
            has_env_api_key: sources.env.azure_api_key.is_some(),
            has_opencode_api_key: sources.opencode_auth.azure_api_key.is_some(),
            has_opencode_endpoint: sources.opencode_config.azure_endpoint.is_some(),
            has_opencode_deployment_name: sources.opencode_config.azure_deployment_name.is_some(),
        },
    })
}

fn persist_settings<R: Runtime>(
    app: &AppHandle<R>,
    request: SaveOpenCodeImageSettingsRequest,
) -> Result<(), String> {
    let mut stored = get_stored_opencode_image_settings(app)?;

    stored.default_provider = request
        .default_provider
        .map(|provider| provider.as_str().to_string());

    if let Some(endpoint) = request.azure_endpoint {
        stored.azure_endpoint = normalize_endpoint(&endpoint)?;
    }

    if let Some(deployment_name) = request.azure_deployment_name {
        stored.azure_deployment_name = normalize_optional(Some(deployment_name.as_str()));
    }

    set_stored_opencode_image_settings(app, &stored)?;

    if request.clear_openai_api_key {
        clear_opencode_image_openai_api_key(app)?;
    } else if let Some(openai_api_key) = normalize_optional(request.openai_api_key.as_deref()) {
        set_opencode_image_openai_api_key(app, &openai_api_key)?;
    }

    if request.clear_azure_api_key {
        clear_opencode_image_azure_api_key(app)?;
    } else if let Some(azure_api_key) = normalize_optional(request.azure_api_key.as_deref()) {
        set_opencode_image_azure_api_key(app, &azure_api_key)?;
    }

    Ok(())
}

fn global_opencode_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let home_dir = app.path().home_dir().map_err(|e| e.to_string())?;
    Ok(home_dir.join(".config").join("opencode"))
}

fn opencode_auth_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let home_dir = app.path().home_dir().map_err(|e| e.to_string())?;
    Ok(home_dir
        .join(".local")
        .join("share")
        .join("opencode")
        .join("auth.json"))
}

fn tool_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(global_opencode_dir(app)?.join("tools").join(TOOL_FILENAME))
}

fn place_tool_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(global_opencode_dir(app)?
        .join("tools")
        .join(PLACE_TOOL_FILENAME))
}

fn normalize_optional(value: Option<&str>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return None;
        }
        Some(trimmed.to_string())
    })
}

fn normalize_endpoint(value: &str) -> Result<Option<String>, String> {
    let Some(trimmed) = normalize_optional(Some(value)) else {
        return Ok(None);
    };
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return Err("Azure endpoint must start with http:// or https://".to_string());
    }
    Ok(Some(trimmed.trim_end_matches('/').to_string()))
}

fn parse_provider(value: Option<&str>) -> Option<ImageProvider> {
    match value?.trim().to_lowercase().as_str() {
        "openai" => Some(ImageProvider::Openai),
        "azure" => Some(ImageProvider::Azure),
        _ => None,
    }
}

fn image_source_snapshot<R: Runtime>(app: &AppHandle<R>) -> Result<ImageSourceSnapshot, String> {
    Ok(ImageSourceSnapshot {
        env: env_snapshot(),
        opencode_auth: read_opencode_auth_snapshot(app)?,
        opencode_config: read_opencode_config_snapshot(app)?,
    })
}

fn resolve_effective_image_config(
    stored: &StoredOpencodeImageSettings,
    stored_openai_api_key: Option<&str>,
    stored_azure_api_key: Option<&str>,
    sources: &ImageSourceSnapshot,
) -> EffectiveImageConfig {
    EffectiveImageConfig {
        openai_api_key: normalize_optional(stored_openai_api_key)
            .or_else(|| sources.env.openai_api_key.clone())
            .or_else(|| sources.opencode_auth.openai_api_key.clone()),
        azure_api_key: normalize_optional(stored_azure_api_key)
            .or_else(|| sources.env.azure_api_key.clone())
            .or_else(|| sources.opencode_auth.azure_api_key.clone()),
        azure_endpoint: normalize_optional(stored.azure_endpoint.as_deref())
            .or_else(|| sources.env.azure_endpoint.clone())
            .or_else(|| sources.opencode_config.azure_endpoint.clone()),
        azure_deployment_name: normalize_optional(stored.azure_deployment_name.as_deref())
            .or_else(|| sources.env.azure_deployment_name.clone())
            .or_else(|| sources.opencode_config.azure_deployment_name.clone()),
    }
}

fn env_snapshot() -> ImageEnvSnapshot {
    let env = merged_env();
    ImageEnvSnapshot {
        openai_api_key: env_value(
            &env,
            &["FALCK_OPENCODE_IMAGE_OPENAI_API_KEY", "OPENAI_API_KEY"],
        ),
        azure_api_key: env_value(
            &env,
            &[
                "FALCK_OPENCODE_IMAGE_AZURE_API_KEY",
                "AZURE_OPENAI_API_KEY",
                "AZURE_OPENAI_KEY",
            ],
        ),
        azure_endpoint: env_value(
            &env,
            &[
                "FALCK_OPENCODE_IMAGE_AZURE_ENDPOINT",
                "AZURE_OPENAI_ENDPOINT",
            ],
        )
        .or_else(|| {
            env_value(
                &env,
                &[
                    "AZURE_RESOURCE_NAME",
                    "AZURE_COGNITIVE_SERVICES_RESOURCE_NAME",
                ],
            )
            .map(|resource| format!("https://{}.openai.azure.com", resource))
        }),
        azure_deployment_name: env_value(
            &env,
            &[
                "AZURE_OPENAI_IMAGE_DEPLOYMENT",
                "AZURE_OPENAI_DEPLOYMENT",
                "AZURE_DEPLOYMENT_NAME",
                "FALCK_OPENCODE_IMAGE_AZURE_DEPLOYMENT",
            ],
        ),
    }
}

fn read_opencode_auth_snapshot<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<OpenCodeAuthSnapshot, String> {
    let auth_path = opencode_auth_path(app)?;
    let Some(raw) = read_optional_text_file(&auth_path) else {
        return Ok(OpenCodeAuthSnapshot::default());
    };

    let auth: HashMap<String, OpenCodeAuthEntry> = match serde_json::from_str(&raw) {
        Ok(auth) => auth,
        Err(err) => {
            eprintln!(
                "[OpenCode] Failed to parse auth file at {}: {}",
                auth_path.display(),
                err
            );
            return Ok(OpenCodeAuthSnapshot::default());
        }
    };

    Ok(OpenCodeAuthSnapshot {
        openai_api_key: usable_opencode_auth_key(auth.get("openai")),
        azure_api_key: usable_opencode_auth_key(auth.get("azure")),
    })
}

fn usable_opencode_auth_key(entry: Option<&OpenCodeAuthEntry>) -> Option<String> {
    let entry = entry?;
    let auth_type = normalize_optional(entry.r#type.as_deref())?;
    if !auth_type.eq_ignore_ascii_case("api") {
        return None;
    }
    normalize_optional(entry.key.as_deref())
}

fn read_opencode_config_snapshot<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<OpenCodeConfigSnapshot, String> {
    let config_dir = global_opencode_dir(app)?;
    let mut snapshot = OpenCodeConfigSnapshot::default();

    for path in [
        config_dir.join("opencode.json"),
        config_dir.join("opencode.jsonc"),
    ] {
        let Some(raw) = read_optional_text_file(&path) else {
            continue;
        };

        let config: OpenCodeConfigFile = match parse_json_like(&raw) {
            Ok(config) => config,
            Err(err) => {
                eprintln!(
                    "[OpenCode] Failed to parse config file at {}: {}",
                    path.display(),
                    err
                );
                continue;
            }
        };

        merge_opencode_config_snapshot(&mut snapshot, config_snapshot_from_file(&config, &path));
    }

    Ok(snapshot)
}

fn merge_opencode_config_snapshot(
    snapshot: &mut OpenCodeConfigSnapshot,
    next: OpenCodeConfigSnapshot,
) {
    if next.azure_endpoint.is_some() {
        snapshot.azure_endpoint = next.azure_endpoint;
    }
    if next.azure_deployment_name.is_some() {
        snapshot.azure_deployment_name = next.azure_deployment_name;
    }
}

fn config_snapshot_from_file(config: &OpenCodeConfigFile, path: &Path) -> OpenCodeConfigSnapshot {
    let Some(azure) = config.provider.get("azure") else {
        return OpenCodeConfigSnapshot::default();
    };

    OpenCodeConfigSnapshot {
        azure_endpoint: normalize_config_endpoint(
            azure
                .options
                .endpoint
                .as_deref()
                .or(azure.options.base_url.as_deref()),
            path,
        )
        .or_else(|| {
            normalize_optional(azure.options.resource_name.as_deref())
                .map(|resource_name| format!("https://{}.openai.azure.com", resource_name))
        }),
        azure_deployment_name: normalize_optional(azure.options.deployment_name.as_deref())
            .or_else(|| infer_azure_image_deployment(&azure.models)),
    }
}

fn normalize_config_endpoint(value: Option<&str>, path: &Path) -> Option<String> {
    let Some(value) = value else {
        return None;
    };

    match normalize_endpoint(value) {
        Ok(endpoint) => endpoint,
        Err(err) => {
            eprintln!(
                "[OpenCode] Ignoring invalid Azure endpoint in {}: {}",
                path.display(),
                err
            );
            None
        }
    }
}

fn infer_azure_image_deployment(
    models: &HashMap<String, OpenCodeModelConfigFile>,
) -> Option<String> {
    models.iter().find_map(|(deployment_name, config)| {
        let normalized_deployment = normalize_optional(Some(deployment_name.as_str()))?;
        if looks_like_gpt_image_model(&normalized_deployment) {
            return Some(normalized_deployment);
        }

        let model_name = normalize_optional(config.name.as_deref())
            .or_else(|| normalize_optional(config.model.as_deref()));
        if model_name
            .as_deref()
            .is_some_and(looks_like_gpt_image_model)
        {
            return Some(normalized_deployment);
        }

        None
    })
}

fn looks_like_gpt_image_model(value: &str) -> bool {
    let normalized = value.trim().to_lowercase();
    normalized.contains(GPT_IMAGE_MODEL) || normalized.contains("gpt-image-1-5")
}

fn read_optional_text_file(path: &Path) -> Option<String> {
    match fs::read_to_string(path) {
        Ok(raw) => Some(raw),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
        Err(err) => {
            eprintln!("[OpenCode] Failed to read {}: {}", path.display(), err);
            None
        }
    }
}

fn parse_json_like<T: DeserializeOwned>(raw: &str) -> Result<T, String> {
    serde_json::from_str(raw)
        .or_else(|_| {
            let without_comments = strip_json_comments(raw);
            let without_trailing_commas = strip_trailing_commas(&without_comments);
            serde_json::from_str(&without_trailing_commas)
        })
        .map_err(|err| err.to_string())
}

fn strip_json_comments(input: &str) -> String {
    let chars = input.chars().collect::<Vec<_>>();
    let mut output = String::with_capacity(input.len());
    let mut index = 0;
    let mut in_string = false;
    let mut escape = false;
    let mut in_line_comment = false;
    let mut in_block_comment = false;

    while index < chars.len() {
        let ch = chars[index];

        if in_line_comment {
            if ch == '\n' || ch == '\r' {
                in_line_comment = false;
                output.push(ch);
            } else {
                output.push(' ');
            }
            index += 1;
            continue;
        }

        if in_block_comment {
            if ch == '*' && index + 1 < chars.len() && chars[index + 1] == '/' {
                output.push(' ');
                output.push(' ');
                index += 2;
                in_block_comment = false;
            } else {
                if ch == '\n' || ch == '\r' {
                    output.push(ch);
                } else {
                    output.push(' ');
                }
                index += 1;
            }
            continue;
        }

        if in_string {
            output.push(ch);
            if escape {
                escape = false;
            } else if ch == '\\' {
                escape = true;
            } else if ch == '"' {
                in_string = false;
            }
            index += 1;
            continue;
        }

        if ch == '"' {
            in_string = true;
            output.push(ch);
            index += 1;
            continue;
        }

        if ch == '/' && index + 1 < chars.len() {
            let next = chars[index + 1];
            if next == '/' {
                in_line_comment = true;
                output.push(' ');
                output.push(' ');
                index += 2;
                continue;
            }
            if next == '*' {
                in_block_comment = true;
                output.push(' ');
                output.push(' ');
                index += 2;
                continue;
            }
        }

        output.push(ch);
        index += 1;
    }

    output
}

fn strip_trailing_commas(input: &str) -> String {
    let chars = input.chars().collect::<Vec<_>>();
    let mut output = String::with_capacity(input.len());
    let mut index = 0;
    let mut in_string = false;
    let mut escape = false;

    while index < chars.len() {
        let ch = chars[index];

        if in_string {
            output.push(ch);
            if escape {
                escape = false;
            } else if ch == '\\' {
                escape = true;
            } else if ch == '"' {
                in_string = false;
            }
            index += 1;
            continue;
        }

        if ch == '"' {
            in_string = true;
            output.push(ch);
            index += 1;
            continue;
        }

        if ch == ',' {
            let mut lookahead = index + 1;
            while lookahead < chars.len() && chars[lookahead].is_whitespace() {
                lookahead += 1;
            }
            if lookahead < chars.len() && matches!(chars[lookahead], '}' | ']') {
                index += 1;
                continue;
            }
        }

        output.push(ch);
        index += 1;
    }

    output
}

fn merged_env() -> HashMap<String, String> {
    let mut env = std::env::vars().collect::<HashMap<_, _>>();
    if let Some(shell_env) = load_shell_env() {
        for (key, value) in shell_env {
            env.entry(key).or_insert(value);
        }
    }
    env
}

fn env_value(env: &HashMap<String, String>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| normalize_optional(env.get(*key).map(String::as_str)))
}
