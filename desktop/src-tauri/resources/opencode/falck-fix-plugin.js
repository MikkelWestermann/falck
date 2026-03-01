import { tool } from "@opencode-ai/plugin";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { parse } from "yaml";

const DEFAULT_TIMEOUT_SEC = 300;
const DEFAULT_LOG_BYTES = 16_384;
const UNIX_PATH_MAX = 104;
const LIMA_SSH_SOCKET_SUFFIX_LEN = "/ssh.sock.".length + 16;

const readText = async (filePath) => {
  try {
    return await fsp.readFile(filePath, "utf8");
  } catch {
    return null;
  }
};

const shellEscape = (value) => {
  const text = String(value ?? "");
  return `'${text.replace(/'/g, `'"'"'`)}'`;
};

const sanitizeName = (value) => {
  const text = String(value ?? "");
  let out = "";
  let lastDash = false;
  for (const ch of text) {
    const allowed = /[A-Za-z0-9]/.test(ch);
    if (allowed) {
      out += ch.toLowerCase();
      lastDash = false;
    } else if (!lastDash) {
      out += "-";
      lastDash = true;
    }
  }
  const trimmed = out.replace(/^-+|-+$/g, "");
  return trimmed || "repo";
};

const fnv1aHash = (value) => {
  const data = Buffer.from(String(value ?? ""));
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (const byte of data) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash;
};

const limaHomeBaseLen = () => {
  const fromEnv = (key) => {
    const value = process.env[key];
    if (!value) return null;
    const trimmed = value.trim().replace(/[\\/]+$/, "");
    return trimmed ? trimmed : null;
  };
  let base = fromEnv("FALCK_LIMA_HOME") || fromEnv("LIMA_HOME");
  if (!base) {
    const home = os.homedir();
    if (!home) return null;
    base = path.join(home, ".falck", "lima");
  }
  const trimmed = base.replace(/[\\/]+$/, "");
  return trimmed ? trimmed.length : null;
};

const maxVmNameLen = () => {
  if (process.platform === "win32") return null;
  const baseLen = limaHomeBaseLen();
  if (baseLen === null) return null;
  const needed = baseLen + 1 + LIMA_SSH_SOCKET_SUFFIX_LEN;
  const limit = UNIX_PATH_MAX - 1;
  if (limit <= needed) return 0;
  return limit - needed;
};

const vmNameForRepo = (repoPath) => {
  const base = path.basename(repoPath || "repo") || "repo";
  const hash = fnv1aHash(repoPath || "");
  const suffix = (hash & 0xffffffffn).toString(16).padStart(8, "0");
  const prefix = "falck-";
  const suffixPart = `-${suffix}`;
  let sanitized = sanitizeName(base);

  const maxLen = maxVmNameLen();
  if (typeof maxLen === "number") {
    if (maxLen === 0) {
      return suffix.slice(0, 1);
    }
    const minLen = prefix.length + suffixPart.length;
    if (maxLen <= minLen) {
      const fallback = `${prefix}${suffix}`;
      if (fallback.length <= maxLen) return fallback;
      return suffix.slice(0, maxLen);
    }
    const allowedBaseLen = maxLen - minLen;
    if (sanitized.length > allowedBaseLen) {
      sanitized = sanitized.slice(0, allowedBaseLen);
    }
    sanitized = sanitized.replace(/^-+|-+$/g, "");
    if (!sanitized) {
      const fallback = "repo";
      sanitized = fallback.slice(0, Math.min(allowedBaseLen, fallback.length));
    }
    const candidate = `${prefix}${sanitized}${suffixPart}`;
    if (candidate.length <= maxLen) return candidate;
  }

  return `${prefix}${sanitized}${suffixPart}`;
};

const limaMountTarget = (repoPath) => {
  const base = path.basename(repoPath || "repo") || "repo";
  const hash = fnv1aHash(repoPath || "");
  const suffix = (hash & 0xffffffffn).toString(16).padStart(8, "0");
  return `/mnt/falck-${sanitizeName(base)}-${suffix}`;
};

const limaLegacyMountTarget = (repoPath) => {
  const base = path.basename(repoPath || "repo") || "repo";
  const hash = fnv1aHash(repoPath || "");
  const suffix = (hash & 0xffffffffn).toString(16).padStart(8, "0");
  return `/mnt/falck/${sanitizeName(base)}-${suffix}`;
};

const resolveLimaHome = () => {
  const envHome = process.env.FALCK_LIMA_HOME || process.env.LIMA_HOME;
  if (envHome && envHome.trim()) return envHome.trim();
  return path.join(os.homedir(), ".lima");
};

const limaInstanceDir = (name) => {
  if (!name) return null;
  return path.join(resolveLimaHome(), name);
};

const readLimaConfig = async (name) => {
  const dir = limaInstanceDir(name);
  if (!dir) return null;
  const candidates = ["lima.yaml", "config.yaml"];
  for (const file of candidates) {
    const full = path.join(dir, file);
    const text = await readText(full);
    if (text) {
      try {
        return parse(text);
      } catch {
        return null;
      }
    }
  }
  return null;
};

const normalizePath = (value) => {
  try {
    return path.resolve(value || "");
  } catch {
    return value || "";
  }
};

const resolveRepoRootInVm = async (repoPath, vmName) => {
  const config = await readLimaConfig(vmName);
  if (config && Array.isArray(config.mounts)) {
    const target = normalizePath(repoPath);
    for (const mount of config.mounts) {
      const location = mount?.location;
      const mountPoint = mount?.mountPoint || mount?.mount_point;
      if (!location || !mountPoint) continue;
      if (normalizePath(location) === target) {
        return mountPoint;
      }
    }
  }
  return limaMountTarget(repoPath);
};

const resolveBackendMode = async (repoPath, requested) => {
  if (requested === "host" || requested === "vm") return requested;
  const envMode = (process.env.FALCK_BACKEND_MODE || "").toLowerCase();
  if (envMode === "host") return "host";
  if (envMode === "virtualized" || envMode === "vm") return "vm";
  if (process.platform === "win32") return "vm";
  const vmName = vmNameForRepo(repoPath);
  const dir = limaInstanceDir(vmName);
  if (dir && fs.existsSync(dir)) return "vm";
  return "host";
};

const toFalckOs = (backendMode) => {
  if (backendMode === "vm") return "linux";
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return process.platform;
};

const toFalckArch = () => {
  if (process.arch === "x64") return "x86_64";
  if (process.arch === "arm64") return "aarch64";
  return process.arch;
};

const buildTemplateContext = (repoRoot, appRoot, backendMode, envMap) => {
  const systemUser =
    envMap.USER || envMap.USERNAME || process.env.USER || process.env.USERNAME || "";
  let systemShell = envMap.SHELL || envMap.ComSpec || process.env.SHELL || process.env.ComSpec || "";
  if (!systemShell && backendMode === "vm") systemShell = "/bin/sh";
  return {
    repo_root: repoRoot,
    app_root: appRoot,
    os: toFalckOs(backendMode),
    arch: toFalckArch(),
    "system.user": systemUser,
    "system.shell": systemShell,
    env: envMap,
  };
};

const resolveTemplateKey = (key, ctx) => {
  if (key === "repo_root") return ctx.repo_root;
  if (key === "app_root") return ctx.app_root;
  if (key === "os") return ctx.os;
  if (key === "arch") return ctx.arch;
  if (key === "system.user") return ctx["system.user"];
  if (key === "system.shell") return ctx["system.shell"];
  if (key.startsWith("env.")) {
    const name = key.slice(4);
    return ctx.env[name] ?? "";
  }
  throw new Error(`Unknown template variable: ${key}`);
};

const resolveTemplate = (input, ctx) => {
  const text = String(input ?? "");
  return text.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match, key) => {
    const trimmed = String(key || "").trim();
    return resolveTemplateKey(trimmed, ctx);
  });
};

const tokenize = (input) => {
  const bytes = Array.from(String(input ?? ""));
  const tokens = [];
  let i = 0;
  while (i < bytes.length) {
    const c = bytes[i];
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    const rest = bytes.slice(i).join("");
    if (rest.startsWith("&&")) {
      tokens.push({ type: "and" });
      i += 2;
      continue;
    }
    if (rest.startsWith("||")) {
      tokens.push({ type: "or" });
      i += 2;
      continue;
    }
    if (rest.startsWith("==")) {
      tokens.push({ type: "eq" });
      i += 2;
      continue;
    }
    if (rest.startsWith("!=")) {
      tokens.push({ type: "ne" });
      i += 2;
      continue;
    }
    if (rest.startsWith(">=")) {
      tokens.push({ type: "ge" });
      i += 2;
      continue;
    }
    if (rest.startsWith("<=")) {
      tokens.push({ type: "le" });
      i += 2;
      continue;
    }
    if (rest.startsWith("contains")) {
      const next = i + "contains".length;
      const nextChar = bytes[next];
      if (!nextChar || !/[A-Za-z0-9_]/.test(nextChar)) {
        tokens.push({ type: "contains" });
        i += "contains".length;
        continue;
      }
    }
    if (c === "(") {
      tokens.push({ type: "lparen" });
      i += 1;
      continue;
    }
    if (c === ")") {
      tokens.push({ type: "rparen" });
      i += 1;
      continue;
    }
    if (c === "!") {
      tokens.push({ type: "not" });
      i += 1;
      continue;
    }
    if (c === ">") {
      tokens.push({ type: "gt" });
      i += 1;
      continue;
    }
    if (c === "<") {
      tokens.push({ type: "lt" });
      i += 1;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      i += 1;
      let value = "";
      while (i < bytes.length) {
        const ch = bytes[i];
        if (ch === "\\" && i + 1 < bytes.length) {
          value += bytes[i + 1];
          i += 2;
          continue;
        }
        if (ch === quote) {
          i += 1;
          break;
        }
        value += ch;
        i += 1;
      }
      tokens.push({ type: "string", value });
      continue;
    }
    if (/[0-9]/.test(c)) {
      const start = i;
      i += 1;
      while (i < bytes.length && /[0-9.]/.test(bytes[i])) i += 1;
      const slice = bytes.slice(start, i).join("");
      const num = Number.parseFloat(slice);
      if (Number.isNaN(num)) throw new Error(`Invalid number: ${slice}`);
      tokens.push({ type: "number", value: num });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const start = i;
      i += 1;
      while (i < bytes.length && /[A-Za-z0-9_.]/.test(bytes[i])) i += 1;
      const slice = bytes.slice(start, i).join("");
      tokens.push({ type: "identifier", value: slice });
      continue;
    }
    throw new Error(`Invalid token in condition: ${c}`);
  }
  return tokens;
};

const makeValue = (value) => {
  if (typeof value === "boolean") return { type: "bool", value };
  if (typeof value === "number") return { type: "number", value };
  return { type: "string", value: String(value ?? "") };
};

const valueAsBool = (value) => {
  if (value.type === "bool") return value.value;
  if (value.type === "number") return value.value !== 0;
  const text = String(value.value || "").toLowerCase();
  if (text === "true") return true;
  if (text === "false") return false;
  return text.length > 0;
};

const valueAsNumber = (value) => {
  if (value.type === "number") return value.value;
  if (value.type === "bool") return value.value ? 1 : 0;
  const num = Number.parseFloat(value.value);
  if (Number.isNaN(num)) return null;
  return num;
};

const valueAsString = (value) => {
  return String(value.value ?? "");
};

const evaluateCondition = (condition, ctx) => {
  if (!condition || !String(condition).trim()) return true;
  const tokens = tokenize(condition);
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const match = (type) => {
    if (peek() && peek().type === type) {
      pos += 1;
      return true;
    }
    return false;
  };

  const parseExpression = () => parseOr();

  const parseOr = () => {
    let left = parseAnd();
    while (match("or")) {
      left = left || parseAnd();
    }
    return left;
  };

  const parseAnd = () => {
    let left = parseNot();
    while (match("and")) {
      left = left && parseNot();
    }
    return left;
  };

  const parseNot = () => {
    if (match("not")) return !parseNot();
    return parseComparison();
  };

  const parseComparison = () => {
    const left = parsePrimary();
    const op = peek();
    if (!op) return valueAsBool(left);
    if (["eq", "ne", "gt", "lt", "ge", "le", "contains"].includes(op.type)) {
      next();
      const right = parsePrimary();
      return compareValues(left, op.type, right);
    }
    return valueAsBool(left);
  };

  const parsePrimary = () => {
    const token = next();
    if (!token) throw new Error("Unexpected end of condition");
    if (token.type === "identifier") {
      const name = token.value;
      if (name.toLowerCase() === "true") return makeValue(true);
      if (name.toLowerCase() === "false") return makeValue(false);
      return makeValue(resolveTemplateKey(name, ctx));
    }
    if (token.type === "string") return makeValue(token.value);
    if (token.type === "number") return makeValue(token.value);
    if (token.type === "lparen") {
      const value = parseExpression();
      if (!match("rparen")) throw new Error("Expected )");
      return makeValue(Boolean(value));
    }
    throw new Error(`Unexpected token: ${token.type}`);
  };

  const compareValues = (left, op, right) => {
    if (op === "eq") return valueAsString(left) === valueAsString(right);
    if (op === "ne") return valueAsString(left) !== valueAsString(right);
    if (op === "contains")
      return valueAsString(left).includes(valueAsString(right));
    if (["gt", "lt", "ge", "le"].includes(op)) {
      const leftNum = valueAsNumber(left);
      const rightNum = valueAsNumber(right);
      if (leftNum === null || rightNum === null) {
        throw new Error("Comparison requires numeric values");
      }
      if (op === "gt") return leftNum > rightNum;
      if (op === "lt") return leftNum < rightNum;
      if (op === "ge") return leftNum >= rightNum;
      if (op === "le") return leftNum <= rightNum;
    }
    throw new Error("Invalid comparison operator");
  };

  const result = parseExpression();
  if (pos < tokens.length) throw new Error("Unexpected tokens remaining");
  return result;
};

const expandCommandSequence = (command) => {
  if (!command) return [];
  if (typeof command === "string") return [{ command, refresh_shell: false }];
  if (Array.isArray(command)) {
    return command
      .map((entry) => {
        if (!entry) return null;
        if (typeof entry === "string") {
          return { command: entry, refresh_shell: false };
        }
        if (typeof entry === "object" && typeof entry.command === "string") {
          return { command: entry.command, refresh_shell: Boolean(entry.refresh_shell) };
        }
        return null;
      })
      .filter(Boolean);
  }
  if (typeof command === "object" && typeof command.command === "string") {
    return [{ command: command.command, refresh_shell: Boolean(command.refresh_shell) }];
  }
  return [];
};

const runProcess = (command, args, options) => {
  const { env, cwd, timeoutSec } = options || {};
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: env || process.env,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer;
    if (timeoutSec && Number.isFinite(timeoutSec)) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutSec * 1000);
    }
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 0, signal, stdout, stderr, timedOut });
    });
  });
};

const runShellCommand = (command, options) => {
  if (process.platform === "win32") {
    return runProcess("cmd.exe", ["/d", "/s", "/c", command], options);
  }
  return runProcess("sh", ["-lc", command], options);
};

const buildEnvExports = (envMap) => {
  const entries = Object.entries(envMap || {});
  if (!entries.length) return "";
  return entries
    .map(([key, value]) => `export ${key}=${shellEscape(value)};`)
    .join(" ");
};

const resolveFalckConfig = async (repoPath) => {
  const configPath = path.join(repoPath, ".falck", "config.yaml");
  const text = await readText(configPath);
  if (!text) {
    throw new Error("No .falck/config.yaml found for this repo.");
  }
  const data = parse(text);
  if (!data || typeof data !== "object") {
    throw new Error("Falck config is empty or invalid.");
  }
  return { config: data, configPath };
};

const resolveApp = (config, appId) => {
  const apps = Array.isArray(config.applications) ? config.applications : [];
  if (apps.length === 0) throw new Error("No applications defined in Falck config.");
  if (!appId) return apps[0];
  const app = apps.find((entry) => entry.id === appId);
  if (!app) throw new Error(`Application '${appId}' not found in Falck config.`);
  return app;
};

const resolveAppRoot = (repoPath, app) => {
  const root = app?.root || ".";
  return path.resolve(repoPath, root);
};

const buildConfigEnv = (config, app, ctx) => {
  const envMap = {};
  if (config?.global_env) {
    for (const [key, value] of Object.entries(config.global_env)) {
      envMap[key] = resolveTemplate(value, ctx);
    }
  }
  if (app?.launch?.env) {
    for (const [key, value] of Object.entries(app.launch.env)) {
      envMap[key] = resolveTemplate(value, ctx);
    }
  }
  return envMap;
};

const runBackendCommand = async ({
  backendMode,
  repoPath,
  appRoot,
  command,
  envMap,
  timeoutSec,
}) => {
  if (backendMode === "vm") {
    const vmName = vmNameForRepo(repoPath);
    const repoRootVm = await resolveRepoRootInVm(repoPath, vmName);
    const rel = path.relative(repoPath, appRoot);
    const appRootVm = rel ? path.posix.join(repoRootVm, rel.split(path.sep).join("/")) : repoRootVm;
    const exports = buildEnvExports(envMap);
    const script = `${exports} cd ${shellEscape(appRootVm)} && ${command}`;
    const provider = process.platform === "win32" ? "wsl" : "lima";
    if (provider === "wsl") {
      return runProcess("wsl", ["-d", vmName, "--", "sh", "-lc", script], {
        timeoutSec,
      });
    }
    const limactl = process.env.FALCK_LIMACTL_PATH || "limactl";
    const env = { ...process.env };
    const limaHome = process.env.FALCK_LIMA_HOME || process.env.LIMA_HOME;
    if (limaHome) env.LIMA_HOME = limaHome;
    return runProcess(
      limactl,
      ["shell", "--tty=false", vmName, "--", "sh", "-lc", script],
      { env, timeoutSec },
    );
  }

  return runShellCommand(command, {
    cwd: appRoot,
    env: { ...process.env, ...envMap },
    timeoutSec,
  });
};

const runSetupStepInternal = async ({ repoPath, appId, stepIndex, backend }) => {
  const { config, configPath } = await resolveFalckConfig(repoPath);
  const app = resolveApp(config, appId);
  const steps = app?.setup?.steps || [];
  if (!steps.length) throw new Error("No setup steps configured for this app.");
  const step = steps[stepIndex];
  if (!step) throw new Error(`Setup step ${stepIndex} not found.`);

  const backendMode = await resolveBackendMode(repoPath, backend);
  const appRoot = resolveAppRoot(repoPath, app);
  const ctx = buildTemplateContext(repoPath, appRoot, backendMode, process.env);
  const envMap = buildConfigEnv(config, app, ctx);

  if (step.only_if) {
    const ok = evaluateCondition(step.only_if, ctx);
    if (!ok) {
      return {
        skipped: true,
        reason: "Condition unmet",
        step: { index: stepIndex, name: step.name },
      };
    }
  }

  const operations = expandCommandSequence(step.command);
  if (!operations.length) throw new Error("Setup step command is empty.");
  const results = [];
  for (const operation of operations) {
    const resolved = resolveTemplate(operation.command, ctx);
    const result = await runBackendCommand({
      backendMode,
      repoPath,
      appRoot,
      command: resolved,
      envMap,
      timeoutSec: step.timeout || DEFAULT_TIMEOUT_SEC,
    });
    results.push({ command: resolved, ...result });
    if (result.code !== 0) {
      if (step.optional) {
        return {
          skipped: true,
          reason: "Optional step failed",
          step: { index: stepIndex, name: step.name },
          results,
          configPath,
        };
      }
      throw new Error(`Setup step '${step.name}' failed.`);
    }
  }

  return {
    ok: true,
    step: { index: stepIndex, name: step.name },
    results,
    configPath,
  };
};

const runSetupAllInternal = async ({ repoPath, appId, backend }) => {
  const { config, configPath } = await resolveFalckConfig(repoPath);
  const app = resolveApp(config, appId);
  const steps = app?.setup?.steps || [];
  if (!steps.length) throw new Error("No setup steps configured for this app.");

  const backendMode = await resolveBackendMode(repoPath, backend);
  const appRoot = resolveAppRoot(repoPath, app);
  const ctx = buildTemplateContext(repoPath, appRoot, backendMode, process.env);
  const envMap = buildConfigEnv(config, app, ctx);

  const runResults = [];
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (step.only_if) {
      const ok = evaluateCondition(step.only_if, ctx);
      if (!ok) {
        runResults.push({
          skipped: true,
          reason: "Condition unmet",
          step: { index, name: step.name },
        });
        continue;
      }
    }
    const operations = expandCommandSequence(step.command);
    if (!operations.length) {
      runResults.push({
        skipped: true,
        reason: "No command",
        step: { index, name: step.name },
      });
      continue;
    }
    const results = [];
    let failed = false;
    for (const operation of operations) {
      const resolved = resolveTemplate(operation.command, ctx);
      const result = await runBackendCommand({
        backendMode,
        repoPath,
        appRoot,
        command: resolved,
        envMap,
        timeoutSec: step.timeout || DEFAULT_TIMEOUT_SEC,
      });
      results.push({ command: resolved, ...result });
      if (result.code !== 0) {
        failed = true;
        if (step.optional) {
          runResults.push({
            skipped: true,
            reason: "Optional step failed",
            step: { index, name: step.name },
            results,
          });
          break;
        }
        throw new Error(`Setup step '${step.name}' failed.`);
      }
    }
    if (!failed) {
      runResults.push({ ok: true, step: { index, name: step.name }, results });
    }
  }

  return { ok: true, results: runResults, configPath };
};

const runTeardownInternal = async ({ repoPath, appId, stepIndex, backend }) => {
  const { config, configPath } = await resolveFalckConfig(repoPath);
  const app = resolveApp(config, appId);
  const steps = app?.setup?.steps || [];
  const step = steps[stepIndex];
  if (!step) throw new Error(`Setup step ${stepIndex} not found.`);
  if (!step.teardown) throw new Error(`No teardown configured for '${step.name}'.`);

  const backendMode = await resolveBackendMode(repoPath, backend);
  const appRoot = resolveAppRoot(repoPath, app);
  const ctx = buildTemplateContext(repoPath, appRoot, backendMode, process.env);
  const envMap = buildConfigEnv(config, app, ctx);

  if (step.only_if) {
    const ok = evaluateCondition(step.only_if, ctx);
    if (!ok) {
      return {
        skipped: true,
        reason: "Condition unmet",
        step: { index: stepIndex, name: step.name },
      };
    }
  }
  if (step.teardown.only_if) {
    const ok = evaluateCondition(step.teardown.only_if, ctx);
    if (!ok) {
      return {
        skipped: true,
        reason: "Teardown condition unmet",
        step: { index: stepIndex, name: step.name },
      };
    }
  }

  const operations = expandCommandSequence(step.teardown.command);
  if (!operations.length) throw new Error("Teardown command is empty.");
  const results = [];
  for (const operation of operations) {
    const resolved = resolveTemplate(operation.command, ctx);
    const result = await runBackendCommand({
      backendMode,
      repoPath,
      appRoot,
      command: resolved,
      envMap,
      timeoutSec: step.teardown.timeout || DEFAULT_TIMEOUT_SEC,
    });
    results.push({ command: resolved, ...result });
    if (result.code !== 0) {
      throw new Error(`Teardown for '${step.name}' failed.`);
    }
  }

  return { ok: true, step: { index: stepIndex, name: step.name }, results, configPath };
};

const ensureVmInternal = async ({ repoPath }) => {
  const vmName = vmNameForRepo(repoPath);
  if (process.platform === "win32") {
    return {
      provider: "wsl",
      vmName,
      message: "Ensure VM is handled by WSL on Windows.",
    };
  }
  const limactl = process.env.FALCK_LIMACTL_PATH || "limactl";
  const env = { ...process.env };
  const limaHome = process.env.FALCK_LIMA_HOME || process.env.LIMA_HOME;
  if (limaHome) env.LIMA_HOME = limaHome;

  const mountsExpr = `.mounts = [{"location": ${JSON.stringify(
    repoPath.replace(/\\/g, "/"),
  )}, "mountPoint": ${JSON.stringify(limaMountTarget(repoPath))}, "writable": true}]`;

  const instanceDir = limaInstanceDir(vmName);
  if (!instanceDir || !fs.existsSync(instanceDir)) {
    const templateCandidate = path.join(resolveLimaHome(), "_templates", "falck-default.yaml");
    const template = fs.existsSync(templateCandidate) ? templateCandidate : "template:default";
    const createArgs = [
      "create",
      "--tty=false",
      "--name",
      vmName,
      "--set",
      mountsExpr,
      template,
    ];
    const created = await runProcess(limactl, createArgs, { env, timeoutSec: DEFAULT_TIMEOUT_SEC });
    if (created.code !== 0) {
      return { vmName, provider: "lima", created, message: "Failed to create VM." };
    }
  }

  const startArgs = ["start", "--tty=false", "--set", mountsExpr, vmName];
  const started = await runProcess(limactl, startArgs, { env, timeoutSec: DEFAULT_TIMEOUT_SEC });
  return { vmName, provider: "lima", started };
};

const readVmLogs = async ({ repoPath, vmName, tailBytes }) => {
  const name = vmName || vmNameForRepo(repoPath);
  const dir = limaInstanceDir(name);
  if (!dir) throw new Error("Unable to resolve Lima instance directory.");
  const files = ["ha.stderr.log", "ha.stdout.log", "serial0.log", "serial.log", "lima.log"];
  const chunks = [];
  const maxBytes = tailBytes || DEFAULT_LOG_BYTES;
  for (const file of files) {
    const full = path.join(dir, file);
    const data = await readText(full);
    if (!data) continue;
    const trimmed = data.length > maxBytes ? data.slice(-maxBytes) : data;
    chunks.push(`--- ${file} ---\n${trimmed.trimEnd()}`);
  }
  if (!chunks.length) {
    return { vmName: name, message: "No VM logs found." };
  }
  return { vmName: name, logs: chunks.join("\n\n") };
};

const getRepoPath = (context, args) => {
  return args?.repoPath || context?.directory || context?.worktree || process.cwd();
};

const listSetupSteps = async (repoPath, appId) => {
  const { config, configPath } = await resolveFalckConfig(repoPath);
  const apps = Array.isArray(config.applications) ? config.applications : [];
  const app = resolveApp(config, appId);
  const steps = app?.setup?.steps || [];
  const summarized = steps.map((step, index) => ({
    index,
    name: step.name,
    optional: Boolean(step.optional),
    only_if: step.only_if || null,
    timeout: step.timeout || null,
    hasTeardown: Boolean(step.teardown),
    command: step.command,
    teardown: step.teardown || null,
  }));
  return {
    configPath,
    apps: apps.map((entry) => ({ id: entry.id, name: entry.name, root: entry.root })),
    app: { id: app.id, name: app.name, root: app.root },
    steps: summarized,
  };
};

const getSpecText = async () => {
  const specPath =
    process.env.FALCK_SPEC_PATH ||
    path.join(os.homedir(), ".config", "opencode", "falck-spec.md");
  const text = await readText(specPath);
  if (!text) throw new Error("Falck spec not found.");
  return text;
};

export const FalckFixPlugin = async () => {
  return {
    tool: {
      "falck.spec": tool({
        description: "Return the Falck spec documentation.",
        args: {},
        async execute() {
          return await getSpecText();
        },
      }),
      "falck.setup.list": tool({
        description: "List setup steps from .falck/config.yaml.",
        args: {
          appId: tool.schema.string().optional(),
          repoPath: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const repoPath = getRepoPath(context, args);
          return await listSetupSteps(repoPath, args.appId);
        },
      }),
      "falck.setup.run": tool({
        description: "Run Falck setup steps. Provide stepIndex to run one, or omit to run all.",
        args: {
          appId: tool.schema.string().optional(),
          stepIndex: tool.schema.number().optional(),
          backend: tool.schema.enum(["auto", "host", "vm"]).optional(),
          repoPath: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const repoPath = getRepoPath(context, args);
          if (typeof args.stepIndex === "number") {
            return await runSetupStepInternal({
              repoPath,
              appId: args.appId,
              stepIndex: args.stepIndex,
              backend: args.backend || "auto",
            });
          }
          return await runSetupAllInternal({
            repoPath,
            appId: args.appId,
            backend: args.backend || "auto",
          });
        },
      }),
      "falck.setup.teardown": tool({
        description: "Run the teardown for a specific setup step.",
        args: {
          appId: tool.schema.string().optional(),
          stepIndex: tool.schema.number(),
          backend: tool.schema.enum(["auto", "host", "vm"]).optional(),
          repoPath: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const repoPath = getRepoPath(context, args);
          return await runTeardownInternal({
            repoPath,
            appId: args.appId,
            stepIndex: args.stepIndex,
            backend: args.backend || "auto",
          });
        },
      }),
      "falck.backend.detect": tool({
        description: "Detect whether Falck is running in host or VM mode.",
        args: {
          repoPath: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const repoPath = getRepoPath(context, args);
          const mode = await resolveBackendMode(repoPath, "auto");
          return { mode };
        },
      }),
      "falck.vm.exec": tool({
        description: "Run a command inside the Falck VM for this repo.",
        args: {
          command: tool.schema.string(),
          repoPath: tool.schema.string().optional(),
          appId: tool.schema.string().optional(),
          timeoutSec: tool.schema.number().optional(),
        },
        async execute(args, context) {
          const repoPath = getRepoPath(context, args);
          const vmName = vmNameForRepo(repoPath);
          const repoRootVm = await resolveRepoRootInVm(repoPath, vmName);
          let cwd = repoRootVm;
          if (args.appId) {
            const { config } = await resolveFalckConfig(repoPath);
            const app = resolveApp(config, args.appId);
            const appRoot = resolveAppRoot(repoPath, app);
            const rel = path.relative(repoPath, appRoot);
            if (rel) {
              cwd = path.posix.join(repoRootVm, rel.split(path.sep).join("/"));
            }
          }
          const script = `cd ${shellEscape(cwd)} && ${args.command}`;
          if (process.platform === "win32") {
            return await runProcess("wsl", ["-d", vmName, "--", "sh", "-lc", script], {
              timeoutSec: args.timeoutSec || DEFAULT_TIMEOUT_SEC,
            });
          }
          const limactl = process.env.FALCK_LIMACTL_PATH || "limactl";
          const env = { ...process.env };
          const limaHome = process.env.FALCK_LIMA_HOME || process.env.LIMA_HOME;
          if (limaHome) env.LIMA_HOME = limaHome;
          return await runProcess(
            limactl,
            ["shell", "--tty=false", vmName, "--", "sh", "-lc", script],
            { env, timeoutSec: args.timeoutSec || DEFAULT_TIMEOUT_SEC },
          );
        },
      }),
      "falck.vm.start": tool({
        description: "Start the Falck VM for this repo.",
        args: {
          repoPath: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const repoPath = getRepoPath(context, args);
          const vmName = vmNameForRepo(repoPath);
          if (process.platform === "win32") {
            return { vmName, provider: "wsl", message: "WSL starts on demand." };
          }
          const limactl = process.env.FALCK_LIMACTL_PATH || "limactl";
          const env = { ...process.env };
          const limaHome = process.env.FALCK_LIMA_HOME || process.env.LIMA_HOME;
          if (limaHome) env.LIMA_HOME = limaHome;
          return await runProcess(limactl, ["start", "--tty=false", vmName], {
            env,
            timeoutSec: DEFAULT_TIMEOUT_SEC,
          });
        },
      }),
      "falck.vm.stop": tool({
        description: "Stop the Falck VM for this repo.",
        args: {
          repoPath: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const repoPath = getRepoPath(context, args);
          const vmName = vmNameForRepo(repoPath);
          if (process.platform === "win32") {
            return await runProcess("wsl", ["--terminate", vmName], {
              timeoutSec: DEFAULT_TIMEOUT_SEC,
            });
          }
          const limactl = process.env.FALCK_LIMACTL_PATH || "limactl";
          const env = { ...process.env };
          const limaHome = process.env.FALCK_LIMA_HOME || process.env.LIMA_HOME;
          if (limaHome) env.LIMA_HOME = limaHome;
          return await runProcess(limactl, ["stop", vmName], {
            env,
            timeoutSec: DEFAULT_TIMEOUT_SEC,
          });
        },
      }),
      "falck.vm.update": tool({
        description: "Ensure the Falck VM exists and has the repo mounted.",
        args: {
          repoPath: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const repoPath = getRepoPath(context, args);
          return await ensureVmInternal({ repoPath });
        },
      }),
      "falck.vm.logs": tool({
        description: "Fetch recent Lima VM logs for this repo.",
        args: {
          repoPath: tool.schema.string().optional(),
          vmName: tool.schema.string().optional(),
          tailBytes: tool.schema.number().optional(),
        },
        async execute(args, context) {
          const repoPath = getRepoPath(context, args);
          return await readVmLogs({
            repoPath,
            vmName: args.vmName,
            tailBytes: args.tailBytes,
          });
        },
      }),
    },
  };
};

export default FalckFixPlugin;
