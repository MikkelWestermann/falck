import {
  type KeyboardEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { unstable_batchedUpdates } from "react-dom";

import type { ChatStatus, ToolUIPart } from "ai";
import {
  AlertTriangleIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  FileIcon,
  FolderIcon,
  PlusIcon,
  SparklesIcon,
  UploadCloudIcon,
  WrenchIcon,
} from "lucide-react";
import { useDropzone } from "react-dropzone";
import { nanoid } from "nanoid";

import {
  Message as AIMessage,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import {
  ToolInput,
  ToolOutput,
  getStatusBadge,
} from "@/components/ai-elements/tool";
import { Loader } from "@/components/ai-elements/loader";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorSeparator,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { AssetUploadDialog } from "@/components/falck/AssetUploadDialog";
import { opencodeService, type OpenCodePartInput } from "@/services/opencodeService";
import type { FalckApplication } from "@/services/falckService";
import { useAIChat, type ChatMessage } from "@/contexts/AIChatContext";

interface AIChatProps {
  activeApp?: FalckApplication | null;
}

type PartSnapshot = {
  id: string;
  type?: string;
  text?: string;
  prompt?: string;
  description?: string;
  synthetic?: boolean;
  ignored?: boolean;
  status?: string;
  output?: unknown;
  errorText?: string;
  input?: unknown;
  toolName?: string;
  tool?: string;
  title?: string;
  role?: "user" | "assistant";
  time?: { start?: number; end?: number };
};

type ToolState = ToolUIPart["state"];

const TOOL_STATE_FALLBACK: ToolState = "input-streaming";
const ACTIVE_TOOL_STATES: ToolState[] = [
  "input-streaming",
  "input-available",
  "approval-requested",
  "approval-responded",
];

type MentionOption = {
  path: string;
  display: string;
  isDir: boolean;
};

type MentionItem = {
  id: string;
  path: string;
};

const normalizeMentionPath = (value: string) => {
  let normalized = value.trim().replace(/\\/g, "/");
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  return normalized;
};

const isAbsolutePath = (value: string) =>
  value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);

const joinPath = (base: string, relative: string) => {
  const normalizedBase = base.replace(/[\\/]+$/, "");
  const normalizedRel = relative.replace(/^[\\/]+/, "");
  if (!normalizedBase) {
    return normalizedRel;
  }
  const separator = normalizedBase.includes("\\") ? "\\" : "/";
  return `${normalizedBase}${separator}${normalizedRel}`;
};

const resolveFilePath = (base: string, relative: string) => {
  const cleaned = relative.replace(/^[.][\\/]/, "");
  if (isAbsolutePath(cleaned)) {
    return cleaned;
  }
  return joinPath(base, cleaned);
};

const encodeFilePath = (filepath: string): string => {
  let normalized = filepath.replace(/\\/g, "/");
  if (/^[A-Za-z]:/.test(normalized)) {
    normalized = "/" + normalized;
  }
  return normalized
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
};

const getFilename = (value: string) => {
  const normalized = value.replace(/\\/g, "/");
  const trimmed = normalized.endsWith("/")
    ? normalized.replace(/\/+$/, "")
    : normalized;
  const parts = trimmed.split("/");
  return parts[parts.length - 1] ?? value;
};

const buildMentionParts = (
  text: string,
  mentions: MentionItem[],
  repoPath: string | null,
): OpenCodePartInput[] => {
  const parts: OpenCodePartInput[] = [{ type: "text", text }];
  if (!repoPath || mentions.length === 0) {
    return parts;
  }

  const counts = new Map<string, number>();
  for (const mention of mentions) {
    const normalized = normalizeMentionPath(mention.path);
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }

  const tokenRegex = /@(\S+)/g;
  let match: RegExpExecArray | null = null;

  while ((match = tokenRegex.exec(text)) !== null) {
    const rawPath = normalizeMentionPath(match[1] ?? "");
    const count = counts.get(rawPath) ?? 0;
    if (count <= 0) {
      continue;
    }
    counts.set(rawPath, count - 1);

    const absolute = resolveFilePath(repoPath, rawPath);
    const token = match[0] ?? `@${rawPath}`;

    parts.push({
      type: "file",
      mime: "text/plain",
      url: `file://${encodeFilePath(absolute)}`,
      filename: getFilename(rawPath),
      source: {
        type: "file",
        path: absolute,
        text: {
          value: token,
          start: match.index,
          end: match.index + token.length,
        },
      },
    });
  }

  return parts;
};

const normalizeAppRoot = (root: string) => {
  let normalized = root.trim();
  while (normalized.startsWith("./") || normalized.startsWith(".\\")) {
    normalized = normalized.slice(2);
  }
  normalized = normalized.replace(/[\\/]+$/, "");
  if (normalized === ".") {
    return "";
  }
  return normalized;
};

const isRepoRoot = (root: string) => normalizeAppRoot(root) === "";

const formatAppRoot = (root: string) => {
  const normalized = normalizeAppRoot(root);
  return normalized ? `./${normalized}` : "the repo root";
};

const buildAppFocusSystem = (app: FalckApplication) => {
  const appName = app.name || app.id || "selected";
  const rootLabel = formatAppRoot(app.root);
  const rootHint =
    rootLabel === "the repo root"
      ? "the repo root"
      : `${rootLabel} (relative to the repo root)`;
  return `Focus on the "${appName}" app in ${rootHint}. Prefer edits inside that path. You can read shared code outside the app root when needed, but avoid modifying files outside it unless the user asks.`;
};

const normalizeToolStatus = (status?: string): ToolState => {
  switch (status) {
    case "input-streaming":
    case "input-available":
    case "approval-requested":
    case "approval-responded":
    case "output-available":
    case "output-error":
    case "output-denied":
      return status;
    case "running":
      return "input-available";
    default:
      return TOOL_STATE_FALLBACK;
  }
};

const resolveToolState = (part: PartSnapshot): ToolState => {
  const normalized = normalizeToolStatus(part.status);
  if (
    normalized === "output-available" ||
    normalized === "output-error" ||
    normalized === "output-denied"
  ) {
    return normalized;
  }
  if (part.errorText) {
    return "output-error";
  }
  if (part.output !== undefined) {
    return "output-available";
  }
  if (normalized === "input-streaming" && part.input !== undefined) {
    return "input-available";
  }
  return normalized;
};

const isToolPart = (part: PartSnapshot) =>
  part.type === "dynamic-tool" ||
  part.type === "tool" ||
  Boolean(part.tool) ||
  Boolean(part.type && part.type.startsWith("tool-"));

const isReasoningPart = (part: PartSnapshot) => part.type === "reasoning";

const isRenderableAssistantPart = (part: PartSnapshot) =>
  !part.synthetic &&
  !part.ignored &&
  (isToolPart(part) ||
    (isReasoningPart(part) &&
      typeof part.text === "string" &&
      part.text.trim().length > 0));

const getPartSortTime = (part: PartSnapshot) =>
  part.time?.start ?? part.time?.end;

const compareParts = (a: PartSnapshot, b: PartSnapshot) => {
  const aTime = getPartSortTime(a);
  const bTime = getPartSortTime(b);
  if (aTime && bTime && aTime !== bTime) {
    return aTime - bTime;
  }
  if (aTime && !bTime) {
    return -1;
  }
  if (!aTime && bTime) {
    return 1;
  }
  return a.id.localeCompare(b.id);
};

const toolLabel = (part: PartSnapshot) => {
  if (part.type === "dynamic-tool") {
    return part.title || part.toolName || "Tool";
  }
  if (part.type === "tool") {
    return part.tool || part.title || part.toolName || "Tool";
  }
  if (part.tool) {
    return part.tool;
  }
  if (part.type?.startsWith("tool-")) {
    return part.type.replace("tool-", "") || "Tool";
  }
  return "Tool";
};

type ToolActivity = {
  id: string;
  name: string;
  state: string;
};

type ConnectionState = "connecting" | "connected" | "error";

type ActivityPhase =
  | "idle"
  | "connecting"
  | "disconnected"
  | "creating-session"
  | "loading-session"
  | "queued"
  | "processing"
  | "streaming"
  | "running-tools"
  | "awaiting-approval"
  | "retrying"
  | "complete";

type StatusMeta = {
  label: string;
  title: string;
  description: string;
  badgeVariant: "default" | "secondary" | "destructive" | "outline";
  isActive: boolean;
  icon: ReactElement;
};

type SessionStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt: number; message: string; next: number };

const formatStatusTime = (value: string) =>
  new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

const MESSAGE_ID_PREFIX = "msg";
const MESSAGE_ID_LENGTH = 26;
let lastMessageTimestamp = 0;
let messageCounter = 0;

const createMessageId = () => {
  const now = Date.now();
  if (now !== lastMessageTimestamp) {
    lastMessageTimestamp = now;
    messageCounter = 0;
  }
  messageCounter += 1;

  let stamp = BigInt(now) * BigInt(0x1000) + BigInt(messageCounter);
  const timeBytes = new Uint8Array(6);
  for (let i = 0; i < 6; i += 1) {
    timeBytes[i] = Number((stamp >> BigInt(40 - 8 * i)) & BigInt(0xff));
  }

  return `${MESSAGE_ID_PREFIX}_${bytesToHex(timeBytes)}${randomBase62(
    MESSAGE_ID_LENGTH - 12,
  )}`;
};

const bytesToHex = (bytes: Uint8Array) => {
  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
};

const randomBase62 = (length: number) => {
  const chars =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const bytes = getRandomBytes(length);
  let result = "";
  for (let i = 0; i < length; i += 1) {
    result += chars[bytes[i] % 62];
  }
  return result;
};

const getRandomBytes = (length: number) => {
  const bytes = new Uint8Array(length);
  if (
    typeof globalThis !== "undefined" &&
    globalThis.crypto &&
    typeof globalThis.crypto.getRandomValues === "function"
  ) {
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  }

  for (let i = 0; i < length; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256);
  }

  return bytes;
};

const TEXT_RENDER_THROTTLE_MS = 100;

const useThrottledValue = (value: string, delay = TEXT_RENDER_THROTTLE_MS) => {
  const [throttled, setThrottled] = useState(value);
  const last = useRef(0);

  useEffect(() => {
    const now = Date.now();
    const remaining = delay - (now - last.current);
    if (remaining <= 0) {
      last.current = now;
      setThrottled(value);
      return;
    }

    const timer = window.setTimeout(() => {
      last.current = Date.now();
      setThrottled(value);
    }, remaining);

    return () => clearTimeout(timer);
  }, [delay, value]);

  return throttled;
};

const ThrottledMessageResponse = ({
  text,
  isStreaming,
}: {
  text: string;
  isStreaming: boolean;
}) => {
  const throttled = useThrottledValue(text);
  if (isStreaming) {
    return (
      <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
        {throttled}
      </div>
    );
  }
  return <MessageResponse>{text}</MessageResponse>;
};

const normalizeSseText = (input: string) =>
  input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

const readSseStream = async (options: {
  url: string;
  signal: AbortSignal;
  onEvent: (data: unknown) => void;
  onError?: (error: unknown) => void;
}) => {
  if (typeof TextDecoderStream === "undefined") {
    throw new Error("TextDecoderStream is not supported");
  }
  const response = await fetch(options.url, {
    headers: { Accept: "text/event-stream" },
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(`SSE failed: ${response.status} ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error("No body in SSE response");
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += value;
      buffer = normalizeSseText(buffer);
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";

      for (const chunk of chunks) {
        const lines = chunk.split("\n");
        const dataLines: string[] = [];
        for (const line of lines) {
          if (line.startsWith("data:")) {
            dataLines.push(line.replace(/^data:\s*/, ""));
          }
        }
        if (!dataLines.length) {
          continue;
        }
        const rawData = dataLines.join("\n");
        try {
          options.onEvent(JSON.parse(rawData));
        } catch (err) {
          options.onError?.(err);
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore reader release errors
    }
  }
};

const compareMessageId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const findInsertIndex = (list: ChatMessage[], messageId: string) => {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const midId = list[mid]?.id ?? "";
    if (compareMessageId(midId, messageId) < 0) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
};

export function AIChat({ activeApp }: AIChatProps) {
  const {
    repoPath,
    currentSession,
    messages,
    setMessages,
    providers,
    selectedModel,
    setSelectedModel,
    serverUrl,
    setHistoryOpen,
    creatingSession,
    loadingSession,
    createSession,
    initializing,
    error,
    setError,
  } = useAIChat();

  const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
  const [inputMessage, setInputMessage] = useState("");
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionOptions, setMentionOptions] = useState<MentionOption[]>([]);
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const [mentionStatus, setMentionStatus] = useState<
    "idle" | "loading" | "error"
  >("idle");
  const [mentionError, setMentionError] = useState<string | null>(null);
  const [mentionAnchor, setMentionAnchor] = useState<{
    start: number;
    end: number;
  } | null>(null);
  const [mentionItems, setMentionItems] = useState<MentionItem[]>([]);
  const [recentMentions, setRecentMentions] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(
    null,
  );
  const [toolActivity, setToolActivity] = useState<ToolActivity[]>([]);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("connecting");
  const [sessionStatus, setSessionStatus] = useState<SessionStatus | null>(
    null,
  );
  const [awaitingResponse, setAwaitingResponse] = useState(false);
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);
  const [lastAssistantCompletion, setLastAssistantCompletion] = useState<
    string | null
  >(null);
  const partsByMessage = useRef<Map<string, Map<string, PartSnapshot>>>(
    new Map(),
  );
  const roleByMessage = useRef<Map<string, "user" | "assistant">>(new Map());
  const pendingUserIds = useRef<Set<string>>(new Set());
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [assetUploadOpen, setAssetUploadOpen] = useState(false);
  const [assetUploadFiles, setAssetUploadFiles] = useState<File[]>([]);

  const assetConfig = activeApp?.assets;
  const canUploadAssets = Boolean(activeApp && assetConfig?.root);
  const appFocusSystem = useMemo(() => {
    if (!activeApp || isRepoRoot(activeApp.root)) {
      return undefined;
    }
    return buildAppFocusSystem(activeApp);
  }, [activeApp]);

  const eventStreamUrl = useMemo(() => {
    const base = serverUrl || "http://127.0.0.1:4096";
    const url = new URL("/event", base);
    url.searchParams.set("directory", repoPath);
    return url.toString();
  }, [repoPath, serverUrl]);

  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.models.includes(selectedModel)),
    [providers, selectedModel],
  );

  const updateMentionState = useCallback(
    (value: string, cursor: number) => {
      if (!repoPath) {
        setMentionOpen(false);
        setMentionQuery("");
        setMentionAnchor(null);
        setMentionStatus("idle");
        setMentionError(null);
        return;
      }

      const slice = value.slice(0, cursor);
      const match = slice.match(/@(\S*)$/);
      if (!match) {
        setMentionOpen(false);
        setMentionQuery("");
        setMentionAnchor(null);
        setMentionStatus("idle");
        setMentionError(null);
        return;
      }

      const query = match[1] ?? "";
      const start = cursor - match[0].length;
      const end = cursor;

      setMentionOpen(true);
      setMentionQuery(query);
      setMentionAnchor({ start, end });
      setMentionActiveIndex(0);
    },
    [repoPath],
  );

  const updateMentionFromCursor = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    const cursor = input.selectionStart ?? input.value.length;
    updateMentionState(input.value, cursor);
  }, [updateMentionState]);

  const applyMention = useCallback(
    (option: MentionOption) => {
      if (!mentionAnchor) return;
      const mentionToken = `@${option.path}`;
      const cursor = mentionAnchor.start + mentionToken.length + 1;

      setInputMessage((prev) => {
        const before = prev.slice(0, mentionAnchor.start);
        const after = prev.slice(mentionAnchor.end);
        return `${before}${mentionToken} ${after}`;
      });

      setMentionItems((prev) => [
        ...prev,
        { id: nanoid(), path: option.path },
      ]);

      setRecentMentions((prev) => {
        const next = [option.path, ...prev.filter((p) => p !== option.path)];
        return next.slice(0, 10);
      });

      setMentionOpen(false);
      setMentionQuery("");
      setMentionAnchor(null);
      setMentionOptions([]);

      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(cursor, cursor);
      });
    },
    [mentionAnchor],
  );

  useEffect(() => {
    if (!mentionOpen) {
      setMentionOptions([]);
      setMentionActiveIndex(0);
      setMentionStatus("idle");
      setMentionError(null);
    }
  }, [mentionOpen]);

  useEffect(() => {
    if (!mentionOpen || !repoPath) return;
    let cancelled = false;
    const query = mentionQuery.trim();
    setMentionStatus("loading");
    setMentionError(null);
    const timeoutId = window.setTimeout(async () => {
      try {
        const [fileResults, dirResults] = await Promise.all([
          opencodeService.findFiles(query, repoPath, {
            type: "file",
            limit: 30,
          }),
          opencodeService.findFiles(query, repoPath, {
            type: "directory",
            limit: 20,
            includeDirs: true,
          }),
        ]);

        if (cancelled) return;

        const normalizedQuery = normalizeMentionPath(query).toLowerCase();
        const seen = new Set<string>();
        const options: MentionOption[] = [];

        const recentMatches = recentMentions.filter((path) => {
          if (!normalizedQuery) return true;
          return path.toLowerCase().includes(normalizedQuery);
        });

        for (const path of recentMatches) {
          const normalized = normalizeMentionPath(path);
          if (seen.has(normalized)) continue;
          seen.add(normalized);
          options.push({ path: normalized, display: normalized, isDir: false });
        }

        for (const path of dirResults) {
          const normalized = normalizeMentionPath(path);
          if (seen.has(normalized)) continue;
          seen.add(normalized);
          options.push({ path: normalized, display: normalized, isDir: true });
        }

        for (const path of fileResults) {
          const normalized = normalizeMentionPath(path);
          if (seen.has(normalized)) continue;
          seen.add(normalized);
          options.push({ path: normalized, display: normalized, isDir: false });
        }

        setMentionOptions(options);
        setMentionActiveIndex((prev) => {
          if (options.length === 0) return 0;
          return Math.min(prev, options.length - 1);
        });
        setMentionStatus("idle");
      } catch {
        if (!cancelled) {
          setMentionOptions([]);
          setMentionStatus("error");
          setMentionError("Unable to search files. Check OpenCode connection.");
        }
      }
    }, 150);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [mentionOpen, mentionQuery, repoPath, recentMentions]);

  const handleMentionKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.isComposing || event.nativeEvent.isComposing) {
        return;
      }
      if (!mentionOpen) return;
      if (mentionOptions.length === 0) {
        if (event.key === "Escape") {
          event.preventDefault();
          setMentionOpen(false);
        }
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionActiveIndex((prev) =>
          Math.min(prev + 1, mentionOptions.length - 1),
        );
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionActiveIndex((prev) => Math.max(prev - 1, 0));
        return;
      }

      if (event.key === "Tab" || event.key === "Enter") {
        event.preventDefault();
        const option =
          mentionOptions[mentionActiveIndex] ?? mentionOptions[0];
        if (option) {
          applyMention(option);
        }
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        setMentionOpen(false);
      }
    },
    [mentionOpen, mentionOptions, mentionActiveIndex, applyMention],
  );

  const handleMentionKeyUp = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.isComposing || event.nativeEvent.isComposing) {
        return;
      }
      if (
        mentionOpen &&
        ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)
      ) {
        return;
      }
      updateMentionFromCursor();
    },
    [mentionOpen, updateMentionFromCursor],
  );

  const handleAssetDrop = useCallback(
    (files: File[]) => {
      if (files.length === 0) {
        return;
      }
      if (!canUploadAssets || !activeApp) {
        setError("No asset directory is configured for this application.");
        return;
      }
      setAssetUploadFiles(files);
      setAssetUploadOpen(true);
    },
    [activeApp, canUploadAssets, setError],
  );

  const {
    getRootProps,
    getInputProps,
    isDragActive: assetDragActive,
    open: openAssetFileDialog,
  } = useDropzone({
    noClick: true,
    noKeyboard: true,
    multiple: true,
    disabled: !canUploadAssets,
    onDrop: (files, _rejections, event) => {
      event?.preventDefault();
      handleAssetDrop(files);
    },
  });

  const handleUploadClick = useCallback(() => {
    if (!canUploadAssets) {
      setError("No asset directory is configured for this application.");
      return;
    }
    openAssetFileDialog();
  }, [canUploadAssets, openAssetFileDialog, setError]);

  const handleAssetDialogOpenChange = useCallback((open: boolean) => {
    setAssetUploadOpen(open);
    if (!open) {
      setAssetUploadFiles([]);
    }
  }, []);

  const chatStatus: ChatStatus | undefined = sending
    ? "submitted"
    : streaming
      ? "streaming"
      : undefined;

  const visibleMessages = useMemo(
    () =>
      messages.filter((msg) => {
        if (msg.text.length > 0) {
          return true;
        }
        const parts = partsByMessage.current.get(msg.id);
        if (!parts) {
          return false;
        }
        for (const part of parts.values()) {
          if (isRenderableAssistantPart(part)) {
            return true;
          }
        }
        return false;
      }),
    [lastEventAt, messages, toolActivity],
  );

  const hasPendingUserMessage = useMemo(
    () => messages.some((msg) => msg.role === "user" && msg.pending),
    [messages],
  );

  const getRenderableParts = (messageId: string) => {
    const parts = partsByMessage.current.get(messageId);
    if (!parts) {
      return { toolParts: [], reasoningParts: [] };
    }
    const orderedParts = Array.from(parts.values())
      .filter((part) => !part.synthetic && !part.ignored)
      .sort(compareParts);
    const toolParts = orderedParts.filter(isToolPart);
    const reasoningParts = orderedParts.filter(
      (part) =>
        isReasoningPart(part) &&
        typeof part.text === "string" &&
        part.text.trim().length > 0,
    );
    return { toolParts, reasoningParts };
  };

  const awaitingApproval = useMemo(
    () => toolActivity.some((tool) => tool.state === "approval-requested"),
    [toolActivity],
  );

  const activityPhase: ActivityPhase = useMemo(() => {
    if (creatingSession) {
      return "creating-session";
    }
    if (loadingSession) {
      return "loading-session";
    }
    if (!currentSession) {
      return "idle";
    }
    if (connectionState === "error") {
      return "disconnected";
    }
    if (connectionState === "connecting") {
      return "connecting";
    }
    if (awaitingApproval) {
      return "awaiting-approval";
    }
    if (toolActivity.length > 0) {
      return "running-tools";
    }
    if (sessionStatus?.type === "retry") {
      return "retrying";
    }
    if (streaming) {
      return "streaming";
    }
    if (sessionStatus?.type === "busy") {
      return "processing";
    }
    if (sending || hasPendingUserMessage || awaitingResponse) {
      return "queued";
    }
    if (sessionStatus?.type === "idle" && lastAssistantCompletion) {
      return "complete";
    }
    if (!sessionStatus && lastAssistantCompletion) {
      return "complete";
    }
    return "idle";
  }, [
    awaitingApproval,
    connectionState,
    creatingSession,
    currentSession,
    hasPendingUserMessage,
    lastAssistantCompletion,
    loadingSession,
    awaitingResponse,
    sessionStatus,
    sending,
    streaming,
    toolActivity.length,
  ]);

  const statusMeta = useMemo<StatusMeta>(() => {
    const toolNames = toolActivity.map((tool) => tool.name).filter(Boolean);
    const toolSummary = toolNames.length
      ? `${toolNames.slice(0, 2).join(", ")}${
          toolNames.length > 2 ? ` +${toolNames.length - 2}` : ""
        }`
      : "tool calls";
    const lastUpdate = lastEventAt
      ? `Last update ${formatStatusTime(lastEventAt)}`
      : "Waiting for OpenCode updates.";
    const completedAt = lastAssistantCompletion
      ? `Completed at ${formatStatusTime(lastAssistantCompletion)}`
      : "Response complete.";
    const retryMessage =
      sessionStatus?.type === "retry"
        ? sessionStatus.message || "Temporary error, retry scheduled."
        : null;

    switch (activityPhase) {
      case "creating-session":
        return {
          label: "Creating session",
          title: "Spinning up a new session",
          description: "OpenCode is preparing a fresh workspace.",
          badgeVariant: "secondary",
          isActive: true,
          icon: <Loader className="text-muted-foreground" size={14} />,
        };
      case "loading-session":
        return {
          label: "Loading session",
          title: "Syncing session history",
          description: "Fetching messages from OpenCode.",
          badgeVariant: "secondary",
          isActive: true,
          icon: <Loader className="text-muted-foreground" size={14} />,
        };
      case "connecting":
        return {
          label: "Connecting",
          title: "Connecting to OpenCode",
          description: "Waiting for the server handshake.",
          badgeVariant: "secondary",
          isActive: true,
          icon: <Loader className="text-muted-foreground" size={14} />,
        };
      case "disconnected":
        return {
          label: "Disconnected",
          title: "Connection lost",
          description:
            "Live status updates stopped. The server may still be running.",
          badgeVariant: "destructive",
          isActive: false,
          icon: <AlertTriangleIcon className="size-4 text-destructive" />,
        };
      case "queued":
        return {
          label: "Queued",
          title: "Queued for processing",
          description: "Message received - waiting for the model to start.",
          badgeVariant: "secondary",
          isActive: true,
          icon: <Loader className="text-muted-foreground" size={14} />,
        };
      case "streaming":
        return {
          label: "Streaming",
          title: "Generating response",
          description: `Streaming tokens from the model. ${lastUpdate}`,
          badgeVariant: "secondary",
          isActive: true,
          icon: <Loader className="text-muted-foreground" size={14} />,
        };
      case "processing":
        return {
          label: "Processing",
          title: "Working on your request",
          description: `OpenCode is busy. ${lastUpdate}`,
          badgeVariant: "secondary",
          isActive: true,
          icon: <Loader className="text-muted-foreground" size={14} />,
        };
      case "awaiting-approval":
        return {
          label: `Awaiting approval (${toolActivity.length})`,
          title: "Waiting for your approval",
          description: `Approve the tool request${
            toolActivity.length > 1 ? "s" : ""
          } to continue.`,
          badgeVariant: "secondary",
          isActive: true,
          icon: <ClockIcon className="size-4 text-amber-600" />,
        };
      case "running-tools":
        return {
          label: `Running tools (${toolActivity.length})`,
          title: "Executing tools",
          description: `Running ${toolSummary}. ${lastUpdate}`,
          badgeVariant: "secondary",
          isActive: true,
          icon: <Loader className="text-muted-foreground" size={14} />,
        };
      case "retrying":
        return {
          label:
            sessionStatus?.type === "retry"
              ? `Retrying (attempt ${sessionStatus.attempt})`
              : "Retrying",
          title: "Retrying request",
          description: retryMessage
            ? retryMessage
            : "OpenCode is retrying the request.",
          badgeVariant: "secondary",
          isActive: true,
          icon: <ClockIcon className="size-4 text-amber-600" />,
        };
      case "complete":
        return {
          label: "Complete",
          title: "Response complete",
          description: completedAt,
          badgeVariant: "outline",
          isActive: false,
          icon: <CheckCircleIcon className="size-4 text-emerald-600" />,
        };
      case "idle":
      default:
        if (!currentSession) {
          return {
            label: "Create a session",
            title: "Create a session to begin",
            description: "Start a new session to see OpenCode responses here.",
            badgeVariant: "outline",
            isActive: false,
            icon: <SparklesIcon className="size-4 text-muted-foreground" />,
          };
        }
        return {
          label: "Ready",
          title: "Ready for the next prompt",
          description: "Waiting for your next message.",
          badgeVariant: "outline",
          isActive: false,
          icon: <SparklesIcon className="size-4 text-muted-foreground" />,
        };
    }
  }, [
    activityPhase,
    currentSession,
    lastAssistantCompletion,
    lastEventAt,
    sessionStatus,
    toolActivity,
  ]);

  const hasActiveWork =
    statusMeta.isActive || (connectionState === "error" && currentSession);
  const activityLabel = statusMeta.label;

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) {
      return;
    }

    const raf = requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });

    return () => cancelAnimationFrame(raf);
  }, [visibleMessages, sending, streaming, currentSession?.path]);

  useEffect(() => {
    if (!repoPath) {
      return;
    }

    setConnectionState("connecting");
    setLastEventAt(null);

    const upsertMessage = (
      messageId: string,
      updates: Partial<ChatMessage>,
      options?: { requireText?: boolean },
    ) => {
      setMessages((prev) => {
        const idx = prev.findIndex((msg) => msg.id === messageId);
        const hasText = typeof updates.text === "string";
        const nextText = hasText ? (updates.text ?? "") : "";
        const hasVisibleText = hasText && nextText.length > 0;
        if (idx === -1) {
          if (options?.requireText && !hasVisibleText) {
            return prev;
          }
          if (!updates.role) {
            return prev;
          }
          const next = [...prev];
          const insertAt = findInsertIndex(next, messageId);
          next.splice(insertAt, 0, {
            id: messageId,
            role: updates.role,
            text: updates.text ?? "",
            timestamp: updates.timestamp ?? new Date().toISOString(),
            pending: updates.pending,
          });
          return next;
        }
        const next = [...prev];
        next[idx] = {
          ...next[idx],
          ...updates,
          id: messageId,
          role: updates.role ?? next[idx].role,
          text: hasText ? nextText : next[idx].text,
          pending: updates.pending ?? next[idx].pending,
        };
        return next;
      });
    };

    const normalizeToolState = (state: unknown) => {
      if (typeof state === "string") {
        return state;
      }
      if (
        state &&
        typeof state === "object" &&
        "status" in state &&
        typeof (state as { status?: unknown }).status === "string"
      ) {
        return (state as { status: string }).status;
      }
      return undefined;
    };

    const extractToolField = (value: unknown, field: string) => {
      if (value && typeof value === "object" && field in value) {
        return (value as Record<string, unknown>)[field];
      }
      return undefined;
    };

    const normalizePart = (
      part: {
        id?: string;
        type?: string;
        text?: string;
        prompt?: string;
        description?: string;
        synthetic?: boolean;
        ignored?: boolean;
        state?: unknown;
        output?: unknown;
        errorText?: string;
        input?: unknown;
        toolName?: string;
        tool?: string;
        title?: string;
        role?: "user" | "assistant";
        time?: { start?: number; end?: number };
      },
      existing?: PartSnapshot,
    ): PartSnapshot => {
      const status = normalizeToolState(part.state) ?? existing?.status;
      const output =
        part.output ??
        extractToolField(part.state, "output") ??
        existing?.output;
      const errorText =
        part.errorText ??
        (extractToolField(part.state, "errorText") as string | undefined) ??
        existing?.errorText;
      const input =
        part.input ?? extractToolField(part.state, "input") ?? existing?.input;

      return {
        id: part.id ?? existing?.id ?? "",
        type: part.type ?? existing?.type,
        text: part.text ?? existing?.text,
        prompt: part.prompt ?? existing?.prompt,
        description: part.description ?? existing?.description,
        synthetic: part.synthetic ?? existing?.synthetic,
        ignored: part.ignored ?? existing?.ignored,
        toolName: part.toolName ?? existing?.toolName,
        tool: part.tool ?? existing?.tool,
        title: part.title ?? existing?.title,
        role: part.role ?? existing?.role,
        time: part.time ?? existing?.time,
        status,
        output,
        errorText,
        input,
      };
    };

    const buildMessageText = (
      parts: Map<string, PartSnapshot>,
      role?: "user" | "assistant",
    ) => {
      const values = Array.from(parts.values()).sort((a, b) =>
        a.id.localeCompare(b.id),
      );
      const textParts = values.filter(
        (part) =>
          part.type === "text" &&
          typeof part.text === "string" &&
          !part.synthetic &&
          !part.ignored,
      );
      if (textParts.length === 0) {
        return "";
      }
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
    };

    const refreshToolActivity = () => {
      const active: ToolActivity[] = [];
      partsByMessage.current.forEach((partMap) => {
        partMap.forEach((part) => {
          if (!isToolPart(part)) {
            return;
          }
          const resolvedState = resolveToolState(part);
          if (ACTIVE_TOOL_STATES.includes(resolvedState)) {
            active.push({
              id: part.id,
              name: toolLabel(part),
              state: resolvedState,
            });
          }
        });
      });
      setToolActivity(active);
    };

    const reconcileUserMessage = (serverId: string, timestamp: string) => {
      setMessages((prev) => {
        const existingIndex = prev.findIndex((msg) => msg.id === serverId);
        if (existingIndex !== -1) {
          const next = [...prev];
          next[existingIndex] = {
            ...next[existingIndex],
            id: serverId,
            pending: false,
            timestamp,
          };
          pendingUserIds.current.delete(serverId);
          return next;
        }

        const pendingIndex = prev.findIndex(
          (msg) => msg.role === "user" && msg.pending,
        );
        if (pendingIndex === -1) {
          return prev;
        }
        const pendingId = prev[pendingIndex]?.id;
        if (pendingId) {
          pendingUserIds.current.delete(pendingId);
        }
        const next = [...prev];
        const pendingMessage = {
          ...next[pendingIndex],
          id: serverId,
          pending: false,
          timestamp,
        };
        next.splice(pendingIndex, 1);
        const insertAt = findInsertIndex(next, serverId);
        next.splice(insertAt, 0, pendingMessage);
        return next;
      });
    };

    const handlePayload = (payload: {
      type?: string;
      properties?: Record<string, unknown>;
    }) => {
      if (payload.type === "server.connected") {
        setConnectionState("connected");
        setLastEventAt(new Date().toISOString());
        return;
      }

      if (payload.type === "session.status") {
        const props = payload.properties as
          | { sessionID?: string; status?: SessionStatus }
          | undefined;
        if (
          !props ||
          props.sessionID !== currentSession?.path ||
          !props.status
        ) {
          return;
        }
        setConnectionState("connected");
        setLastEventAt(new Date().toISOString());
        setSessionStatus(props.status);
        if (props.status.type !== "busy") {
          setAwaitingResponse(false);
        }
        return;
      }

      if (payload.type === "session.idle") {
        const props = payload.properties as { sessionID?: string } | undefined;
        if (!props || props.sessionID !== currentSession?.path) {
          return;
        }
        setConnectionState("connected");
        setLastEventAt(new Date().toISOString());
        setSessionStatus({ type: "idle" });
        setStreaming(false);
        setStreamingMessageId(null);
        setAwaitingResponse(false);
        return;
      }

      if (payload.type === "session.error") {
        const props = payload.properties as
          | { sessionID?: string; error?: unknown; message?: string }
          | undefined;
        if (!props || props.sessionID !== currentSession?.path) {
          return;
        }
        setConnectionState("connected");
        setLastEventAt(new Date().toISOString());
        setSessionStatus({ type: "idle" });
        setStreaming(false);
        setStreamingMessageId(null);
        setAwaitingResponse(false);
        const detail =
          props.message ??
          (props.error ? JSON.stringify(props.error) : "Unknown error");
        setError(`OpenCode error: ${detail}`);
        return;
      }

      if (payload.type === "message.part.updated") {
        const props = payload.properties as
          | {
              part?: {
                sessionID?: string;
                messageID?: string;
                id?: string;
                type?: string;
                text?: string;
                role?: "user" | "assistant";
                prompt?: string;
                description?: string;
                state?: unknown;
                output?: unknown;
                errorText?: string;
                input?: unknown;
                toolName?: string;
                tool?: string;
                synthetic?: boolean;
                ignored?: boolean;
                title?: string;
                time?: { start?: number; end?: number };
              };
              delta?: string;
            }
          | undefined;
        const part = props?.part;
        if (
          !part ||
          part.sessionID !== currentSession?.path ||
          !part.messageID ||
          !part.id
        ) {
          return;
        }
        setConnectionState("connected");
        setLastEventAt(new Date().toISOString());
        const byPart = partsByMessage.current.get(part.messageID) ?? new Map();
        const prevPart = byPart.get(part.id);
        let hydratedPart = part;
        if (typeof props?.delta === "string") {
          const prevText = prevPart?.text ?? "";
          const nextText =
            typeof part.text === "string" ? part.text : undefined;
          const shouldAppend =
            typeof nextText !== "string" || nextText === prevText;
          if (shouldAppend) {
            hydratedPart = {
              ...part,
              text: prevText + props.delta,
            };
          } else if (prevText && nextText.length < prevText.length) {
            hydratedPart = {
              ...part,
              text: prevText + props.delta,
            };
          }
        }
        const normalized = normalizePart(hydratedPart, prevPart);
        byPart.set(part.id, normalized);
        partsByMessage.current.set(part.messageID, byPart);
        let resolvedRole =
          normalized.role ??
          part.role ??
          roleByMessage.current.get(part.messageID) ??
          (pendingUserIds.current.has(part.messageID) ? "user" : undefined);
        if (!resolvedRole) {
          if (
            normalized.type === "text" ||
            normalized.type === "reasoning" ||
            isToolPart(normalized)
          ) {
            resolvedRole = "assistant";
          }
        }
        if (resolvedRole) {
          roleByMessage.current.set(part.messageID, resolvedRole);
        }
        const combined = buildMessageText(byPart, resolvedRole);
        if (
          resolvedRole &&
          (combined.length > 0 ||
            (resolvedRole === "assistant" &&
              isRenderableAssistantPart(normalized)))
        ) {
          const partTimestamp =
            part.time?.end ?? part.time?.start ?? Date.now();
          upsertMessage(
            part.messageID,
            {
              role: resolvedRole,
              text: combined,
              timestamp: new Date(partTimestamp).toISOString(),
            },
            combined.length > 0 ? { requireText: true } : undefined,
          );
        }
        if (
          resolvedRole === "assistant" &&
          (normalized.type === "text" || normalized.type === "reasoning")
        ) {
          setStreaming(true);
          setStreamingMessageId(part.messageID);
          setSessionStatus((prev) =>
            prev?.type === "busy" ? prev : { type: "busy" },
          );
          setAwaitingResponse(false);
        }
        if (
          isToolPart(normalized) &&
          ACTIVE_TOOL_STATES.includes(resolveToolState(normalized))
        ) {
          setSessionStatus((prev) =>
            prev?.type === "busy" ? prev : { type: "busy" },
          );
          setAwaitingResponse(false);
        }
        refreshToolActivity();
        return;
      }

      if (payload.type === "message.updated") {
        const info = payload.properties?.info as
          | {
              id?: string;
              sessionID?: string;
              role?: "user" | "assistant";
              time?: { created?: number; completed?: number };
            }
          | undefined;
        if (!info || info.sessionID !== currentSession?.path || !info.id) {
          return;
        }
        setConnectionState("connected");
        setLastEventAt(new Date().toISOString());
        const timestamp = info.time?.created
          ? new Date(info.time.created).toISOString()
          : new Date().toISOString();
        const resolvedRole =
          info.role ?? roleByMessage.current.get(info.id) ?? undefined;
        if (resolvedRole) {
          roleByMessage.current.set(info.id, resolvedRole);
        }
        if (resolvedRole === "user") {
          pendingUserIds.current.delete(info.id);
          reconcileUserMessage(info.id, timestamp);
          const parts = partsByMessage.current.get(info.id);
          if (parts) {
            const combined = buildMessageText(parts, "user");
            if (combined.length > 0) {
              upsertMessage(info.id, { text: combined, timestamp });
            }
          }
        } else {
          const parts = partsByMessage.current.get(info.id);
          const combined = parts ? buildMessageText(parts, "assistant") : "";
          if (combined.length > 0) {
            upsertMessage(
              info.id,
              {
                role: resolvedRole ?? "assistant",
                text: combined,
                timestamp,
              },
              { requireText: true },
            );
          } else if (resolvedRole) {
            upsertMessage(info.id, { role: resolvedRole, timestamp });
          }
        }
        if (resolvedRole === "assistant" && info.time?.completed) {
          setStreaming(false);
          setStreamingMessageId((prev) => (prev === info.id ? null : prev));
          setLastAssistantCompletion(
            new Date(info.time.completed).toISOString(),
          );
          setAwaitingResponse(false);
          refreshToolActivity();
        }
      }

      if (payload.type === "message.removed") {
        const props = payload.properties as
          | { sessionID?: string; messageID?: string }
          | undefined;
        if (
          !props ||
          props.sessionID !== currentSession?.path ||
          !props.messageID
        ) {
          return;
        }
        setConnectionState("connected");
        setLastEventAt(new Date().toISOString());
        pendingUserIds.current.delete(props.messageID);
        roleByMessage.current.delete(props.messageID);
        partsByMessage.current.delete(props.messageID);
        setStreamingMessageId((prev) =>
          prev === props.messageID ? null : prev,
        );
        setMessages((prev) => prev.filter((msg) => msg.id !== props.messageID));
        refreshToolActivity();
        return;
      }

      if (payload.type === "message.part.removed") {
        const props = payload.properties as
          | { messageID?: string; partID?: string }
          | undefined;
        if (!props?.messageID || !props.partID) {
          return;
        }
        const parts = partsByMessage.current.get(props.messageID);
        if (parts) {
          parts.delete(props.partID);
          if (parts.size === 0) {
            partsByMessage.current.delete(props.messageID);
          }
        }
        const role = roleByMessage.current.get(props.messageID);
        const combined = parts ? buildMessageText(parts, role) : "";
        upsertMessage(props.messageID, { text: combined });
        refreshToolActivity();
      }
    };

    const enqueueEvent = (payload: {
      type?: string;
      properties?: Record<string, unknown>;
    }) => {
      const key = (() => {
        if (payload.type === "session.status") {
          const props = payload.properties as
            | { sessionID?: string }
            | undefined;
          return props?.sessionID
            ? `session.status:${props.sessionID}`
            : undefined;
        }
        if (payload.type === "message.part.updated") {
          const props = payload.properties as
            | { part?: { messageID?: string; id?: string } }
            | undefined;
          const messageId = props?.part?.messageID;
          const partId = props?.part?.id;
          if (messageId && partId) {
            return `message.part.updated:${messageId}:${partId}`;
          }
        }
        return undefined;
      })();

      if (key) {
        const existing = coalesced.get(key);
        if (existing !== undefined) {
          queue[existing] = undefined;
        }
        coalesced.set(key, queue.length);
      }
      queue.push(payload);
      schedule();
    };

    let queue: Array<
      { type?: string; properties?: Record<string, unknown> } | undefined
    > = [];
    let buffer: Array<
      { type?: string; properties?: Record<string, unknown> } | undefined
    > = [];
    const coalesced = new Map<string, number>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastFlush = 0;

    const flush = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (queue.length === 0) {
        return;
      }
      const events = queue;
      queue = buffer;
      buffer = events;
      queue.length = 0;
      coalesced.clear();
      lastFlush = Date.now();
      unstable_batchedUpdates(() => {
        for (const event of events) {
          if (!event) {
            continue;
          }
          handlePayload(event);
        }
      });
      buffer.length = 0;
    };

    const schedule = () => {
      if (timer) {
        return;
      }
      const elapsed = Date.now() - lastFlush;
      timer = setTimeout(flush, Math.max(0, 16 - elapsed));
    };

    const handleRawEvent = (data: unknown) => {
      if (!data || typeof data !== "object") {
        return;
      }
      if ("payload" in data) {
        const directory =
          "directory" in data && typeof data.directory === "string"
            ? data.directory
            : undefined;
        if (directory && directory !== repoPath) {
          return;
        }
        const payload = (data as { payload?: unknown }).payload;
        if (payload && typeof payload === "object") {
          enqueueEvent(
            payload as { type?: string; properties?: Record<string, unknown> },
          );
        }
        return;
      }
      enqueueEvent(
        data as { type?: string; properties?: Record<string, unknown> },
      );
    };

    const abortController = new AbortController();
    let eventSource: EventSource | null = null;

    const startEventSource = () => {
      if (eventSource) {
        return;
      }
      eventSource = new EventSource(eventStreamUrl);
      eventSource.onmessage = (event) => {
        if (!event.data) {
          return;
        }
        try {
          handleRawEvent(JSON.parse(event.data));
        } catch (err) {
          console.error("[OpenCode] Failed to parse event:", err);
        }
      };
      eventSource.onerror = (err) => {
        console.error("[OpenCode] Event stream error", err);
        setConnectionState("error");
      };
    };

    const startStream = async () => {
      try {
        await readSseStream({
          url: eventStreamUrl,
          signal: abortController.signal,
          onEvent: handleRawEvent,
          onError: (err) => console.error("[OpenCode] SSE parse error", err),
        });
      } catch (err) {
        if (abortController.signal.aborted) {
          return;
        }
        console.error("[OpenCode] SSE stream failed", err);
        setConnectionState("error");
        startEventSource();
      }
    };

    void startStream();

    return () => {
      abortController.abort();
      if (eventSource) {
        eventSource.close();
      }
      flush();
    };
  }, [currentSession?.path, eventStreamUrl, repoPath]);

  const formatMessageTime = (value: string) =>
    new Date(value).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

  const handleSendMessage = async (messageText?: string) => {
    const rawText = messageText ?? inputMessage;
    const trimmed = rawText.trim();
    if (!trimmed || !currentSession) {
      return;
    }

    setLastAssistantCompletion(null);
    setAwaitingResponse(true);
    setStreamingMessageId(null);
    const messageId = createMessageId();
    const userMessage: ChatMessage = {
      id: messageId,
      role: "user",
      text: trimmed,
      timestamp: new Date().toISOString(),
      pending: true,
    };

    pendingUserIds.current.add(messageId);
    roleByMessage.current.set(messageId, "user");
    setMessages((prev) => {
      const next = [...prev];
      const insertAt = findInsertIndex(next, messageId);
      next.splice(insertAt, 0, userMessage);
      return next;
    });
    const mentionSnapshot = mentionItems.slice();
    setInputMessage("");
    setMentionItems([]);
    setMentionOpen(false);
    setMentionQuery("");
    setMentionAnchor(null);
    setMentionOptions([]);
    setSending(true);
    setStreaming(true);
    setError("");

    try {
      const parts = buildMentionParts(rawText, mentionSnapshot, repoPath);
      await opencodeService.sendPromptAsync(
        currentSession.path,
        rawText,
        selectedModel,
        messageId,
        repoPath,
        appFocusSystem,
        parts,
      );
    } catch (err) {
      setError(`Failed to get response: ${String(err)}`);
      pendingUserIds.current.delete(messageId);
      roleByMessage.current.delete(messageId);
      setMessages((prev) => prev.filter((msg) => msg.id !== messageId));
      setStreaming(false);
      setStreamingMessageId(null);
      setAwaitingResponse(false);
    } finally {
      setSending(false);
    }
  };

  useEffect(() => {
    if (!currentSession) return;
    partsByMessage.current.clear();
    roleByMessage.current.clear();
    pendingUserIds.current.clear();
    setStreaming(false);
    setStreamingMessageId(null);
    setToolActivity([]);
    setSessionStatus(null);
    setAwaitingResponse(false);
    setMentionItems([]);
    setMentionOpen(false);
    setMentionQuery("");
    setMentionAnchor(null);
    setMentionOptions([]);
  }, [currentSession?.path]);

  useEffect(() => {
    if (!currentSession) return;
    roleByMessage.current.clear();
    messages.forEach((msg) => {
      roleByMessage.current.set(msg.id, msg.role);
    });
    const lastAssistantMessage = [...messages]
      .reverse()
      .find((msg) => msg.role === "assistant");
    setLastAssistantCompletion(
      lastAssistantMessage ? lastAssistantMessage.timestamp : null,
    );
  }, [currentSession?.path, messages]);

  if (initializing) {
    return (
      <div className="rounded-2xl border-2 border-dashed border-border/70 bg-card/85 px-4 py-10 text-center text-sm text-muted-foreground shadow-[var(--shadow-xs)]">
        Initializing OpenCode...
      </div>
    );
  }

  return (
    <>
      <div
        {...getRootProps({
          className: "relative flex flex-col",
          onDragOver: (event) => {
            event.preventDefault();
          },
        })}
      >
        <input {...getInputProps()} />
        {assetDragActive && canUploadAssets && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/60 bg-background/80 backdrop-blur-sm">
            <div className="flex flex-col items-center gap-2 text-sm font-semibold text-foreground">
              <UploadCloudIcon className="size-5" />
              <span>Drop files to upload assets</span>
              {assetConfig?.root && (
                <span className="text-xs text-muted-foreground">
                  {assetConfig.root}
                </span>
              )}
            </div>
          </div>
        )}
        <div className="flex flex-1 flex-col min-h-0">
          <div className="flex-1 min-h-0 px-6 pb-6">
            <div>
              <div
                ref={messagesContainerRef}
                className="flex flex-1 min-h-[400px] flex-col gap-4 overflow-y-auto px-6 py-4 h-[calc(100vh-320px)]"
              >
                {loadingSession ? (
                  <div className="flex flex-1 flex-col items-center justify-center rounded-2xl border border-dashed border-border/60 bg-card/80 px-6 py-12 text-center">
                    <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-foreground/5">
                      <SparklesIcon className="size-5 animate-pulse text-muted-foreground" />
                    </div>
                    <h3 className="text-base font-semibold text-foreground">
                      Loading session...
                    </h3>
                    <p className="mt-2 max-w-md text-sm text-muted-foreground">
                      Pulling the latest messages from your history.
                    </p>
                  </div>
                ) : !currentSession ? (
                  <div className="flex flex-1 flex-col items-center justify-center rounded-2xl border border-dashed border-border/60 bg-card/80 px-6 py-12 text-center">
                    <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-foreground/5">
                      <SparklesIcon className="size-5 text-muted-foreground" />
                    </div>
                    <h3 className="text-base font-semibold text-foreground">
                      Start a focused AI chat
                    </h3>
                    <p className="mt-2 max-w-md text-sm text-muted-foreground">
                      Create a new chat or revisit your history to keep
                      discussions organized by task.
                    </p>
                    <div className="mt-6 flex flex-wrap justify-center gap-2">
                      <Button
                        onClick={() => createSession()}
                        disabled={creatingSession}
                        size="sm"
                        className="gap-2"
                      >
                        <PlusIcon className="size-4" />
                        {creatingSession ? "Creating..." : "New chat"}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="rounded-full border-border/60 bg-card/85 px-3 text-xs font-semibold shadow-[var(--shadow-xs)]"
                        onClick={() => setHistoryOpen(true)}
                      >
                        Browse history
                      </Button>
                    </div>
                  </div>
                ) : visibleMessages.length === 0 ? (
                  <div className="flex flex-1 flex-col items-center justify-center rounded-2xl border border-dashed border-border/60 bg-card/80 px-6 py-12 text-center">
                    <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-foreground/5">
                      <SparklesIcon className="size-5 text-muted-foreground" />
                    </div>
                    <h3 className="text-base font-semibold text-foreground">
                      Your chat is ready
                    </h3>
                    <p className="mt-2 max-w-md text-sm text-muted-foreground">
                      Ask Falck AI anything. Responses will appear here with
                      full context.
                    </p>
                  </div>
                ) : (
                  visibleMessages.map((msg, idx) => {
                    const { toolParts, reasoningParts } = getRenderableParts(
                      msg.id,
                    );
                    const isAssistant = msg.role === "assistant";
                    const isMessageStreaming =
                      isAssistant && streaming && streamingMessageId === msg.id;

                    return (
                      <AIMessage
                        key={msg.id ?? `${msg.timestamp}-${idx}`}
                        from={msg.role}
                        className={cn(
                          "max-w-[88%] gap-3",
                          msg.role === "user"
                            ? "lg:max-w-[70%]"
                            : "lg:max-w-[80%]",
                        )}
                      >
                        {isAssistant &&
                          reasoningParts.map((part) => (
                            <Reasoning
                              key={part.id}
                              isStreaming={isMessageStreaming}
                              className="w-full"
                            >
                              <ReasoningTrigger />
                              <ReasoningContent>
                                {part.text ?? ""}
                              </ReasoningContent>
                            </Reasoning>
                          ))}
                        {(msg.role === "user" || msg.text.length > 0) && (
                          <MessageContent className="min-w-[200px]">
                            <div className="flex items-center justify-between text-[0.6rem] uppercase tracking-[0.3em] opacity-70">
                              <span>
                                {msg.role === "user" ? "You" : "Falck AI"}
                              </span>
                              <span>{formatMessageTime(msg.timestamp)}</span>
                            </div>
                            {msg.text.length > 0 && (
                              <ThrottledMessageResponse
                                text={msg.text}
                                isStreaming={isMessageStreaming}
                              />
                            )}
                          </MessageContent>
                        )}
                        {isAssistant &&
                          toolParts.map((part) => {
                            const toolState = resolveToolState(part);
                            const toolTitle = toolLabel(part);
                            const toolDescription = part.description?.trim();
                            const hasInput = part.input !== undefined;
                            const hasOutput =
                              part.output !== undefined || part.errorText;

                            return (
                              <Dialog key={part.id}>
                                <DialogTrigger asChild>
                                  <button
                                    className="group flex w-full items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground"
                                    type="button"
                                  >
                                    <WrenchIcon className="size-4 shrink-0" />
                                    <span className="min-w-0 truncate text-left">
                                      {toolTitle}
                                    </span>
                                    {getStatusBadge(toolState)}
                                    <ChevronRightIcon className="ml-auto size-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
                                  </button>
                                </DialogTrigger>
                                <DialogContent className="max-w-2xl">
                                  <DialogHeader className="gap-2">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                      <DialogTitle className="text-base">
                                        {toolTitle}
                                      </DialogTitle>
                                      {getStatusBadge(toolState)}
                                    </div>
                                    <DialogDescription>
                                      {toolDescription ||
                                        "Tool execution details."}
                                    </DialogDescription>
                                  </DialogHeader>
                                  <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-2">
                                    {hasInput && (
                                      <ToolInput input={part.input} />
                                    )}
                                    {hasOutput ? (
                                      <ToolOutput
                                        output={part.output}
                                        errorText={part.errorText}
                                      />
                                    ) : (
                                      <div className="rounded-md border border-dashed border-border/60 p-4 text-xs text-muted-foreground">
                                        No output yet.
                                      </div>
                                    )}
                                  </div>
                                </DialogContent>
                              </Dialog>
                            );
                          })}
                      </AIMessage>
                    );
                  })
                )}
              </div>

              <div>
                <div className="relative">
                  <PromptInput
                    onSubmit={(message, event) => {
                      event.preventDefault();
                      void handleSendMessage(message.text);
                    }}
                    enableDrop={false}
                  >
                    <PromptInputBody>
                      <PromptInputTextarea
                        ref={inputRef}
                        rows={3}
                        value={inputMessage}
                        className="bg-background"
                        onChange={(event) => {
                          setInputMessage(event.target.value);
                          const cursor =
                            event.target.selectionStart ??
                            event.target.value.length;
                          updateMentionState(event.target.value, cursor);
                        }}
                        onKeyDown={handleMentionKeyDown}
                        onKeyUp={handleMentionKeyUp}
                        onClick={() => updateMentionFromCursor()}
                        onFocus={() => updateMentionFromCursor()}
                        onBlur={() => {
                          window.setTimeout(() => setMentionOpen(false), 150);
                        }}
                        placeholder={
                          currentSession
                            ? "Ask Falck AI. Press Enter to send."
                            : "Create a session to start chatting."
                        }
                        disabled={!currentSession || sending || loadingSession}
                        aria-disabled={
                          !currentSession || sending || loadingSession
                        }
                      />
                    </PromptInputBody>
                    <PromptInputFooter className="border-t border-border/40 bg-card/90">
                      <PromptInputTools className="flex-col items-start gap-1 text-xs text-muted-foreground">
                        <div
                          className="flex flex-wrap items-center gap-2"
                          aria-live="polite"
                          aria-busy={hasActiveWork}
                          title={statusMeta.title}
                        >
                          <span className="inline-flex items-center gap-1.5 text-[0.7rem] font-medium text-foreground/80">
                            <span className="shrink-0">{statusMeta.icon}</span>
                            <span>{activityLabel}</span>
                          </span>
                          <span className="text-muted-foreground/80">
                            {statusMeta.description}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span>
                            {currentSession
                              ? "Enter to send, Shift+Enter for a new line."
                              : "Create a session to start writing."}
                          </span>
                        </div>
                      </PromptInputTools>
                      <PromptInputTools>
                        <Button
                          variant="outline"
                          size="sm"
                          type="button"
                          onClick={handleUploadClick}
                          disabled={!canUploadAssets}
                          className="gap-2"
                        >
                          <UploadCloudIcon className="size-4" />
                          Upload
                        </Button>
                        <ModelSelector
                          open={modelSelectorOpen}
                          onOpenChange={setModelSelectorOpen}
                        >
                          <ModelSelectorTrigger asChild>
                            <Button variant="outline" size="sm" type="button">
                              {selectedProvider && (
                                <ModelSelectorLogo
                                  provider={selectedProvider.name}
                                  className="size-4"
                                />
                              )}
                              <ModelSelectorName className="max-w-[160px] flex-none truncate font-mono text-[0.7rem]">
                                {selectedModel}
                              </ModelSelectorName>
                              <ChevronDownIcon className="size-3 text-muted-foreground" />
                            </Button>
                          </ModelSelectorTrigger>
                          <ModelSelectorContent className="max-w-xl">
                            <div className="border-b px-4 py-3 text-xs font-semibold uppercase tracking-[0.3em] text-muted-foreground">
                              Choose a model
                            </div>
                            <ModelSelectorInput placeholder="Search models..." />
                            <ModelSelectorList className="max-h-[380px]">
                              <ModelSelectorEmpty>
                                No models found.
                              </ModelSelectorEmpty>
                              {providers.map((provider, index) => (
                                <div key={provider.name}>
                                  <ModelSelectorGroup heading={provider.name}>
                                    {provider.models.map((model) => (
                                      <ModelSelectorItem
                                        key={`${provider.name}-${model}`}
                                        value={`${provider.name} ${model}`}
                                        onSelect={() => {
                                          setSelectedModel(model);
                                          setModelSelectorOpen(false);
                                        }}
                                        className={cn(
                                          "flex items-center gap-2",
                                          selectedModel === model
                                            ? "bg-accent/60 text-foreground"
                                            : "",
                                        )}
                                      >
                                        <ModelSelectorLogo
                                          provider={provider.name}
                                        />
                                        <ModelSelectorName className="text-sm">
                                          {model}
                                        </ModelSelectorName>
                                        {selectedModel === model && (
                                          <Badge
                                            variant="secondary"
                                            className="ml-auto rounded-full px-2 py-0 text-[0.6rem]"
                                          >
                                            Active
                                          </Badge>
                                        )}
                                      </ModelSelectorItem>
                                    ))}
                                  </ModelSelectorGroup>
                                  {index < providers.length - 1 && (
                                    <ModelSelectorSeparator />
                                  )}
                                </div>
                              ))}
                            </ModelSelectorList>
                          </ModelSelectorContent>
                        </ModelSelector>
                        <PromptInputSubmit
                          status={chatStatus}
                          disabled={
                            !currentSession ||
                            !inputMessage.trim() ||
                            sending ||
                            loadingSession
                          }
                        />
                      </PromptInputTools>
                    </PromptInputFooter>
                  </PromptInput>

                  {mentionOpen && (
                    <div className="absolute bottom-full left-0 right-0 mb-2 max-h-64 overflow-auto rounded-xl border border-border/60 bg-card/95 shadow-[var(--shadow-xs)] backdrop-blur">
                      {(mentionStatus !== "idle" ||
                        mentionOptions.length === 0) && (
                        <div
                          className={cn(
                            "px-3 py-2 text-xs",
                            mentionStatus === "error"
                              ? "text-destructive"
                              : "text-muted-foreground",
                          )}
                          aria-live="polite"
                        >
                          {mentionStatus === "loading" && (
                            <span className="inline-flex items-center gap-2">
                              <Loader size={12} />
                              Searching files...
                            </span>
                          )}
                          {mentionStatus === "error" && (
                            <span>
                              {mentionError ||
                                "Unable to search files. Check OpenCode connection."}
                            </span>
                          )}
                          {mentionStatus === "idle" &&
                            mentionOptions.length === 0 && (
                              <span>No files found.</span>
                            )}
                        </div>
                      )}
                      {mentionOptions.length > 0 && (
                        <div className="py-1">
                          {mentionOptions.slice(0, 10).map((option, index) => {
                            const separatorIndex =
                              option.path.lastIndexOf("/");
                            const dir =
                              separatorIndex >= 0
                                ? option.path.slice(0, separatorIndex + 1)
                                : "";
                            const name =
                              separatorIndex >= 0
                                ? option.path.slice(separatorIndex + 1)
                                : option.path;

                            return (
                              <button
                                key={`${option.path}-${index}`}
                                type="button"
                                className={cn(
                                  "flex w-full items-center gap-2 px-3 py-2 text-sm text-left transition-colors",
                                  index === mentionActiveIndex
                                    ? "bg-accent"
                                    : "hover:bg-accent/60",
                                )}
                                onMouseDown={(event) => {
                                  event.preventDefault();
                                  applyMention(option);
                                }}
                                onMouseEnter={() =>
                                  setMentionActiveIndex(index)
                                }
                              >
                                {option.isDir ? (
                                  <FolderIcon className="size-4 text-muted-foreground" />
                                ) : (
                                  <FileIcon className="size-4 text-muted-foreground" />
                                )}
                                <span className="truncate text-muted-foreground">
                                  {dir}
                                </span>
                                <span className="truncate font-medium text-foreground">
                                  {name || option.path}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {error && (
          <div className="px-6 pb-6 pt-0">
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </div>
        )}
      </div>

      <AssetUploadDialog
        open={assetUploadOpen}
        onOpenChange={handleAssetDialogOpenChange}
        repoPath={repoPath}
        app={activeApp ?? undefined}
        files={assetUploadFiles}
        onUploaded={() => setAssetUploadFiles([])}
      />
    </>
  );
}
