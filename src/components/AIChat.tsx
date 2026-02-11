import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";
import { unstable_batchedUpdates } from "react-dom";

import type { ChatStatus, ToolUIPart } from "ai";
import {
  AlertTriangleIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  HistoryIcon,
  PlusIcon,
  SparklesIcon,
  WrenchIcon,
} from "lucide-react";

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
import {
  AISession,
  Message,
  Provider,
  opencodeService,
} from "@/services/opencodeService";
import type { FalckApplication } from "@/services/falckService";

interface AIChatProps {
  repoPath: string;
  activeApp?: FalckApplication | null;
}

type ChatMessage = Omit<Message, "id"> & {
  id: string;
  pending?: boolean;
};

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

const compareMessageId = (a: string, b: string) =>
  a < b ? -1 : a > b ? 1 : 0;

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

export function AIChat({ repoPath, activeApp }: AIChatProps) {
  const MODEL_STORAGE_KEY = "falck.opencode.model";
  const [sessions, setSessions] = useState<AISession[]>([]);
  const [currentSession, setCurrentSession] = useState<AISession | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [selectedModel, setSelectedModel] = useState("gpt-4");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
  const [inputMessage, setInputMessage] = useState("");
  const [creatingSession, setCreatingSession] = useState(false);
  const [loadingSession, setLoadingSession] = useState(false);
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(
    null,
  );
  const [error, setError] = useState("");
  const [initializing, setInitializing] = useState(true);
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
  const appFocusSystem = useMemo(() => {
    if (!activeApp || isRepoRoot(activeApp.root)) {
      return undefined;
    }
    return buildAppFocusSystem(activeApp);
  }, [activeApp]);

  const readStoredModel = () => {
    try {
      return window.localStorage.getItem(MODEL_STORAGE_KEY) || "";
    } catch {
      return "";
    }
  };

  const persistModel = (model: string) => {
    try {
      window.localStorage.setItem(MODEL_STORAGE_KEY, model);
    } catch {
      // ignore storage errors
    }
  };

  const eventStreamUrl = useMemo(() => {
    const url = new URL("http://127.0.0.1:4096/event");
    url.searchParams.set("directory", repoPath);
    return url.toString();
  }, [repoPath]);

  const sortedSessions = useMemo(() => {
    return [...sessions].sort(
      (a, b) => new Date(b.created).getTime() - new Date(a.created).getTime(),
    );
  }, [sessions]);

  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.models.includes(selectedModel)),
    [providers, selectedModel],
  );

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
    void initializeOpenCode();
  }, []);

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
        const nextText = hasText ? updates.text ?? "" : "";
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
        if (!props || props.sessionID !== currentSession?.path || !props.status) {
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
        const props = payload.properties as
          | { sessionID?: string }
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
          (props.error ? String(props.error) : "Unknown error");
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
          const partTimestamp = part.time?.end ?? part.time?.start ?? Date.now();
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
          setSessionStatus((prev) => (prev?.type === "busy" ? prev : { type: "busy" }));
          setAwaitingResponse(false);
        }
        if (
          isToolPart(normalized) &&
          ACTIVE_TOOL_STATES.includes(resolveToolState(normalized))
        ) {
          setSessionStatus((prev) => (prev?.type === "busy" ? prev : { type: "busy" }));
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
        const resolvedRole = info.role ?? roleByMessage.current.get(info.id) ?? undefined;
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
          setLastAssistantCompletion(new Date(info.time.completed).toISOString());
          setAwaitingResponse(false);
          refreshToolActivity();
        }
      }

      if (payload.type === "message.removed") {
        const props = payload.properties as
          | { sessionID?: string; messageID?: string }
          | undefined;
        if (!props || props.sessionID !== currentSession?.path || !props.messageID) {
          return;
        }
        setConnectionState("connected");
        setLastEventAt(new Date().toISOString());
        pendingUserIds.current.delete(props.messageID);
        roleByMessage.current.delete(props.messageID);
        partsByMessage.current.delete(props.messageID);
        setStreamingMessageId((prev) => (prev === props.messageID ? null : prev));
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
          const props = payload.properties as { sessionID?: string } | undefined;
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
      | { type?: string; properties?: Record<string, unknown> }
      | undefined
    > = [];
    let buffer: Array<
      | { type?: string; properties?: Record<string, unknown> }
      | undefined
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
          enqueueEvent(payload as { type?: string; properties?: Record<string, unknown> });
        }
        return;
      }
      enqueueEvent(data as { type?: string; properties?: Record<string, unknown> });
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
          onError: (err) =>
            console.error("[OpenCode] SSE parse error", err),
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

  const initializeOpenCode = async () => {
    setInitializing(true);
    try {
      await opencodeService.health(repoPath);
      const config = await opencodeService.getProviders(repoPath);
      setProviders(config.providers);
      const availableModels = config.providers.flatMap(
        (provider) => provider.models,
      );
      const storedModel = readStoredModel();
      const fallbackModel =
        config.defaults?.openai ||
        config.defaults?.opencode ||
        availableModels[0] ||
        "gpt-4";
      const nextModel =
        storedModel && availableModels.includes(storedModel)
          ? storedModel
          : fallbackModel;
      setSelectedModel(nextModel);
      persistModel(nextModel);
      const sessionList = await opencodeService.listSessions(repoPath);
      setSessions(sessionList);
      let shouldClearError = true;

      if (sessionList.length > 0) {
        const latestSession = [...sessionList].sort((a, b) => {
          const aTime = new Date(a.created).getTime();
          const bTime = new Date(b.created).getTime();
          return bTime - aTime;
        })[0];

        if (latestSession) {
          const didSelect = await handleSelectSession(latestSession);
          if (!didSelect) {
            shouldClearError = false;
          }
        }
      } else {
        const name = `AI Session - ${new Date().toLocaleString()}`;
        const session = await opencodeService.createSession(
          name,
          `Chat session for ${repoPath}`,
          nextModel,
          repoPath,
        );
        setSessions([session]);
        setCurrentSession(session);
        setMessages([]);
        setInputMessage("");
        setStreaming(false);
        setStreamingMessageId(null);
        partsByMessage.current.clear();
        setToolActivity([]);
        roleByMessage.current.clear();
        pendingUserIds.current.clear();
        setLastAssistantCompletion(null);
        setSessionStatus(null);
        setAwaitingResponse(false);
      }

      if (shouldClearError) {
        setError("");
      }
    } catch (err) {
      setError(`Failed to initialize OpenCode: ${String(err)}`);
    } finally {
      setInitializing(false);
    }
  };

  const formatSessionTime = (value: string) => new Date(value).toLocaleString();

  const formatMessageTime = (value: string) =>
    new Date(value).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

  const handleCreateSession = async (options?: { closeHistory?: boolean }) => {
    const name = `AI Session - ${new Date().toLocaleString()}`;
    if (options?.closeHistory) {
      setHistoryOpen(false);
    }
    setCreatingSession(true);
    try {
      const session = await opencodeService.createSession(
        name,
        `Chat session for ${repoPath}`,
        selectedModel,
        repoPath,
      );
      setSessions((prev) => [...prev, session]);
      setCurrentSession(session);
      setMessages([]);
      setInputMessage("");
      setStreaming(false);
      setStreamingMessageId(null);
      partsByMessage.current.clear();
      setToolActivity([]);
      roleByMessage.current.clear();
      pendingUserIds.current.clear();
      setLastAssistantCompletion(null);
      setSessionStatus(null);
      setAwaitingResponse(false);
      setError("");
    } catch (err) {
      setError(`Failed to create session: ${String(err)}`);
    } finally {
      setCreatingSession(false);
    }
  };

  const handleSelectSession = async (
    session: AISession,
    options?: { closeHistory?: boolean },
  ): Promise<boolean> => {
    if (options?.closeHistory) {
      setHistoryOpen(false);
    }
    setLoadingSession(true);
    setStreaming(false);
    partsByMessage.current.clear();
    setMessages([]);
    setInputMessage("");
    setToolActivity([]);
    roleByMessage.current.clear();
    pendingUserIds.current.clear();
    setLastAssistantCompletion(null);
    setSessionStatus(null);
    setAwaitingResponse(false);
    setStreamingMessageId(null);
    try {
      const loadedSession = await opencodeService.getSession(
        session.path,
        repoPath,
      );
      setCurrentSession(loadedSession);
      const sessionMessages = await opencodeService.listMessages(
        session.path,
        repoPath,
      );
      const sortedMessages = sessionMessages
        .filter((msg): msg is Message & { id: string } => Boolean(msg.id))
        .map((msg) => ({ ...msg, id: msg.id, pending: false }))
        .sort((a, b) => compareMessageId(a.id, b.id));
      setMessages(sortedMessages);
      roleByMessage.current.clear();
      sortedMessages.forEach((msg) => {
        roleByMessage.current.set(msg.id, msg.role);
      });
      const lastAssistantMessage = [...sortedMessages]
        .reverse()
        .find((msg) => msg.role === "assistant");
      setLastAssistantCompletion(
        lastAssistantMessage ? lastAssistantMessage.timestamp : null,
      );
      if (loadedSession.model) {
        setSelectedModel(loadedSession.model);
        persistModel(loadedSession.model);
      }
      setError("");
      return true;
    } catch (err) {
      setError(`Failed to load session: ${String(err)}`);
      return false;
    } finally {
      setLoadingSession(false);
    }
  };

  const handleSendMessage = async (messageText?: string) => {
    const text = (messageText ?? inputMessage).trim();
    if (!text || !currentSession) {
      return;
    }

    setLastAssistantCompletion(null);
    setAwaitingResponse(true);
    setStreamingMessageId(null);
    const messageId = createMessageId();
    const userMessage: ChatMessage = {
      id: messageId,
      role: "user",
      text,
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
    setInputMessage("");
    setSending(true);
    setStreaming(true);
    setError("");

    try {
      await opencodeService.sendPromptAsync(
        currentSession.path,
        text,
        selectedModel,
        messageId,
        repoPath,
        appFocusSystem,
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

  const handleDeleteSession = async (session: AISession) => {
    if (!window.confirm(`Delete session "${session.name}"?`)) {
      return;
    }

    try {
      await opencodeService.deleteSession(session.path, repoPath);
      setSessions((prev) => prev.filter((s) => s.path !== session.path));
      if (currentSession?.path === session.path) {
        setCurrentSession(null);
        setMessages([]);
        setStreaming(false);
        setStreamingMessageId(null);
        partsByMessage.current.clear();
        setToolActivity([]);
        roleByMessage.current.clear();
        pendingUserIds.current.clear();
        setLastAssistantCompletion(null);
        setSessionStatus(null);
        setAwaitingResponse(false);
      }
      setError("");
    } catch (err) {
      setError(`Failed to delete session: ${String(err)}`);
    }
  };

  if (initializing) {
    return (
      <div className="rounded-2xl border-2 border-dashed border-border/70 bg-white/80 px-4 py-10 text-center text-sm text-muted-foreground shadow-[var(--shadow-xs)]">
        Initializing OpenCode...
      </div>
    );
  }

  return (
    <>
      <div className="relative flex h-[min(72vh,720px)] min-h-[420px] flex-col mt-4">
        <div className="flex flex-wrap items-start justify-end border-b border-border/60 px-6 py-2 backdrop-blur">
          <div className="flex flex-wrap items-center gap-2">
            <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm">
                  <HistoryIcon className="size-4" />
                  <Badge
                    variant="outline"
                    className="rounded-full px-2 py-0 text-[0.6rem]"
                  >
                    {sessions.length}
                  </Badge>
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader className="border-b border-border/60 px-6 py-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <DialogTitle>Session history</DialogTitle>
                      <DialogDescription>
                        Pick up where you left off or start a fresh thread.
                      </DialogDescription>
                    </div>
                    <Button
                      onClick={() =>
                        handleCreateSession({ closeHistory: true })
                      }
                      disabled={creatingSession}
                      size="sm"
                      className="gap-2"
                    >
                      <PlusIcon className="size-4" />
                      {creatingSession ? "Creating..." : "New chat"}
                    </Button>
                  </div>
                </DialogHeader>
                <div className="max-h-[60vh] space-y-3 overflow-y-auto px-6 py-5">
                  {sortedSessions.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-border/60 bg-white/70 px-4 py-8 text-center text-sm text-muted-foreground">
                      No sessions yet. Start a new one to build your history.
                    </div>
                  ) : (
                    sortedSessions.map((session) => (
                      <div
                        key={session.path}
                        className={cn(
                          "flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-white/80 px-4 py-3 shadow-[var(--shadow-xs)] transition hover:-translate-y-[1px] hover:shadow-[var(--shadow-sm)]",
                          currentSession?.path === session.path
                            ? "border-primary/40 bg-secondary/40"
                            : "",
                        )}
                      >
                        <button
                          className="flex-1 text-left disabled:pointer-events-none disabled:opacity-60"
                          onClick={() =>
                            handleSelectSession(session, {
                              closeHistory: true,
                            })
                          }
                          disabled={loadingSession}
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-semibold text-foreground">
                              {session.name}
                            </span>
                            {currentSession?.path === session.path && (
                              <Badge
                                variant="secondary"
                                className="rounded-full px-2 py-0 text-[0.6rem]"
                              >
                                Active
                              </Badge>
                            )}
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            <ClockIcon className="size-3" />
                            <span>{formatSessionTime(session.created)}</span>
                            <span className="text-muted-foreground/60">•</span>
                            <span className="font-mono text-[0.7rem]">
                              {session.model}
                            </span>
                          </div>
                        </button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDeleteSession(session)}
                          disabled={loadingSession}
                        >
                          Delete
                        </Button>
                      </div>
                    ))
                  )}
                </div>
              </DialogContent>
            </Dialog>
            <Button
              onClick={() => handleCreateSession()}
              disabled={creatingSession}
              size="sm"
              className="gap-2"
            >
              <PlusIcon className="size-4" />
              {creatingSession ? "Creating..." : "New chat"}
            </Button>
          </div>
        </div>

        <div className="flex flex-1 flex-col min-h-0">
          <div className="flex-1 min-h-0 px-6 pb-6">
            <div>
              <div
                ref={messagesContainerRef}
                className="flex flex-1 min-h-[400px] flex-col gap-6 overflow-y-auto px-6 py-6 h-[calc(100vh-400px)]"
              >
                {loadingSession ? (
                  <div className="flex flex-1 flex-col items-center justify-center rounded-2xl border border-dashed border-border/60 bg-white/70 px-6 py-12 text-center">
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
                  <div className="flex flex-1 flex-col items-center justify-center rounded-2xl border border-dashed border-border/60 bg-white/70 px-6 py-12 text-center">
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
                        onClick={() => handleCreateSession()}
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
                        className="rounded-full border-border/60 bg-white/80 px-3 text-xs font-semibold shadow-[var(--shadow-xs)]"
                        onClick={() => setHistoryOpen(true)}
                      >
                        Browse history
                      </Button>
                    </div>
                  </div>
                ) : visibleMessages.length === 0 ? (
                  <div className="flex flex-1 flex-col items-center justify-center rounded-2xl border border-dashed border-border/60 bg-white/70 px-6 py-12 text-center">
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
                <div>
                  <PromptInput
                    onSubmit={(message, event) => {
                      event.preventDefault();
                      void handleSendMessage(message.text);
                    }}
                  >
                    <PromptInputBody>
                      <PromptInputTextarea
                        rows={3}
                        value={inputMessage}
                        className="bg-background"
                        onChange={(event) =>
                          setInputMessage(event.target.value)
                        }
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
                    <PromptInputFooter className="border-t border-border/40 bg-white/60">
                      <PromptInputTools className="text-xs text-muted-foreground">
                        <div className="flex flex-wrap items-center gap-2">
                          <span>
                            {currentSession
                              ? "Enter to send, Shift+Enter for a new line."
                              : "Create a session to start writing."}
                          </span>
                          {hasActiveWork && (
                            <>
                              <span
                                className="inline-flex items-center gap-1.5 text-[0.65rem] text-muted-foreground/80 animate-pulse"
                                aria-live="polite"
                                aria-busy="true"
                              >
                                <span className="inline-block size-1 shrink-0 rounded-full bg-muted-foreground/50" />
                                <span>{activityLabel}</span>
                              </span>
                            </>
                          )}
                        </div>
                      </PromptInputTools>
                      <PromptInputTools>
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
                                          persistModel(model);
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
    </>
  );
}
