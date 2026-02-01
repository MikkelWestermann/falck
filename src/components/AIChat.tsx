import { useEffect, useMemo, useRef, useState } from "react";

import type { ChatStatus } from "ai";
import {
  ChevronDownIcon,
  ClockIcon,
  HistoryIcon,
  PlusIcon,
  SparklesIcon,
} from "lucide-react";

import {
  Message as AIMessage,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
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
  PromptInputHeader,
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

interface AIChatProps {
  repoPath: string;
}

type ChatMessage = Message & {
  pending?: boolean;
};

type PartSnapshot = {
  id: string;
  type?: string;
  text?: string;
  prompt?: string;
  description?: string;
  status?: string;
  output?: unknown;
  errorText?: string;
  input?: unknown;
  toolName?: string;
  title?: string;
};

type ToolActivity = {
  id: string;
  name: string;
  state: string;
};

export function AIChat({ repoPath }: AIChatProps) {
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
  const [error, setError] = useState("");
  const [initializing, setInitializing] = useState(true);
  const [toolActivity, setToolActivity] = useState<ToolActivity[]>([]);
  const partsByMessage = useRef<Map<string, Map<string, PartSnapshot>>>(new Map());
  const roleByMessage = useRef<Map<string, "user" | "assistant">>(new Map());
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);

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
    () => messages.filter((msg) => msg.text.trim().length > 0),
    [messages],
  );

  const hasActiveWork =
    sending ||
    streaming ||
    toolActivity.length > 0 ||
    loadingSession ||
    creatingSession;

  const activityLabel = useMemo(() => {
    if (creatingSession) {
      return "Creating session...";
    }
    if (loadingSession) {
      return "Loading session...";
    }
    if (!currentSession) {
      return "Create a session to begin";
    }
    if (sending) {
      return "Sending message...";
    }
    if (toolActivity.length > 0) {
      const awaitingApproval = toolActivity.some(
        (tool) => tool.state === "approval-requested",
      );
      if (awaitingApproval) {
        return `Awaiting approval (${toolActivity.length} tool${
          toolActivity.length > 1 ? "s" : ""
        })...`;
      }
      const toolNames = toolActivity
        .map((tool) => tool.name)
        .filter(Boolean);
      if (toolNames.length > 0) {
        const displayed = toolNames.slice(0, 2).join(", ");
        const extra = toolNames.length > 2 ? ` +${toolNames.length - 2}` : "";
        return `Running: ${displayed}${extra}...`;
      }
      return `Running ${toolActivity.length} tool${
        toolActivity.length > 1 ? "s" : ""
      }...`;
    }
    if (streaming) {
      return "Generating response...";
    }
    return "Ready";
  }, [
    currentSession,
    creatingSession,
    loadingSession,
    sending,
    streaming,
    toolActivity,
  ]);

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

    const source = new EventSource(eventStreamUrl);

    const upsertMessage = (
      messageId: string,
      updates: Partial<ChatMessage>,
      options?: { requireText?: boolean },
    ) => {
      setMessages((prev) => {
        const idx = prev.findIndex((msg) => msg.id === messageId);
        const hasText =
          typeof updates.text === "string" && updates.text.trim().length > 0;
        if (idx === -1) {
          if (options?.requireText && !hasText) {
            return prev;
          }
          if (!updates.role) {
            return prev;
          }
          return [
            ...prev,
            {
              id: messageId,
              role: updates.role,
              text: updates.text ?? "",
              timestamp: updates.timestamp ?? new Date().toISOString(),
              pending: updates.pending,
            },
          ];
        }
        const next = [...prev];
        next[idx] = {
          ...next[idx],
          ...updates,
          id: messageId,
          role: updates.role ?? next[idx].role,
          text: hasText ? updates.text ?? "" : next[idx].text,
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
        state?: unknown;
        output?: unknown;
        errorText?: string;
        input?: unknown;
        toolName?: string;
        title?: string;
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
        part.input ??
        extractToolField(part.state, "input") ??
        existing?.input;

      return {
        id: part.id ?? existing?.id ?? "",
        type: part.type ?? existing?.type,
        text: part.text ?? existing?.text,
        prompt: part.prompt ?? existing?.prompt,
        description: part.description ?? existing?.description,
        toolName: part.toolName ?? existing?.toolName,
        title: part.title ?? existing?.title,
        status,
        output,
        errorText,
        input,
      };
    };

    const isToolPart = (part: PartSnapshot) =>
      part.type === "dynamic-tool" ||
      Boolean(part.type && part.type.startsWith("tool-"));

    const toolLabel = (part: PartSnapshot) => {
      if (part.type === "dynamic-tool") {
        return part.title || part.toolName || "Tool";
      }
      if (part.type?.startsWith("tool-")) {
        return part.type.replace("tool-", "") || "Tool";
      }
      return "Tool";
    };

    const formatOutput = (value: unknown) => {
      if (typeof value === "string") {
        return value.trim();
      }
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return String(value);
      }
    };

    const buildMessageText = (parts: Map<string, PartSnapshot>) => {
      const values = Array.from(parts.values());
      const textParts = values
        .filter((part) => part.type === "text" && part.text?.trim())
        .map((part) => part.text!.trim());
      if (textParts.length > 0) {
        return textParts.join("\n");
      }

      const toolOutputs = values
        .filter((part) => {
          if (!isToolPart(part)) {
            return false;
          }
          const hasOutput = part.output !== undefined || part.errorText;
          if (!hasOutput) {
            return false;
          }
          if (!part.status) {
            return true;
          }
          return [
            "output-available",
            "output-error",
            "output-denied",
          ].includes(part.status);
        })
        .map((part) =>
          part.errorText ? part.errorText.trim() : formatOutput(part.output),
        )
        .filter((text) => text.trim().length > 0);
      if (toolOutputs.length > 0) {
        return toolOutputs.join("\n");
      }

      const reasoningParts = values
        .filter((part) => part.type === "reasoning" && part.text?.trim())
        .map((part) => part.text!.trim());
      if (reasoningParts.length > 0) {
        return reasoningParts.join("\n");
      }

      const subtaskParts = values
        .filter((part) => part.type === "subtask")
        .map((part) => part.description || part.prompt)
        .filter((text): text is string => Boolean(text?.trim()))
        .map((text) => text.trim());
      if (subtaskParts.length > 0) {
        return subtaskParts.join("\n");
      }

      const fallback = values
        .map((part) => part.text)
        .filter((text): text is string => Boolean(text?.trim()))
        .map((text) => text.trim());
      return fallback.join("\n");
    };

    const refreshToolActivity = () => {
      const active: ToolActivity[] = [];
      partsByMessage.current.forEach((partMap) => {
        partMap.forEach((part) => {
          if (!isToolPart(part) || !part.status) {
            return;
          }
          if (
            [
              "input-streaming",
              "input-available",
              "approval-requested",
              "approval-responded",
            ].includes(part.status)
          ) {
            active.push({
              id: part.id,
              name: toolLabel(part),
              state: part.status,
            });
          }
        });
      });
      setToolActivity(active);
    };

    const reconcileUserMessage = (serverId: string, timestamp: string) => {
      setMessages((prev) => {
        const pendingIndex = prev.findIndex(
          (msg) => msg.role === "user" && msg.pending,
        );
        const existingIndex = prev.findIndex((msg) => msg.id === serverId);
        if (pendingIndex === -1 && existingIndex === -1) {
          return prev;
        }
        const next = [...prev];
        if (pendingIndex !== -1) {
          next[pendingIndex] = {
            ...next[pendingIndex],
            id: serverId,
            pending: false,
            timestamp,
          };
        }
        if (existingIndex !== -1 && existingIndex !== pendingIndex) {
          next[existingIndex] = {
            ...next[existingIndex],
            timestamp,
          };
          if (pendingIndex !== -1) {
            next.splice(existingIndex, 1);
          }
        }
        return next;
      });
    };

    source.onmessage = (event) => {
      if (!event.data) {
        return;
      }
      try {
        const payload = JSON.parse(event.data) as {
          type?: string;
          properties?: Record<string, unknown>;
        };

        if (payload.type === "message.part.updated") {
          const part = payload.properties?.part as
            | {
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
                title?: string;
                time?: { start?: number; end?: number };
              }
            | undefined;
          if (
            !part ||
            part.sessionID !== currentSession?.path ||
            !part.messageID ||
            !part.id
          ) {
            return;
          }
          const byPart =
            partsByMessage.current.get(part.messageID) ?? new Map();
          const normalized = normalizePart(part, byPart.get(part.id));
          byPart.set(part.id, normalized);
          partsByMessage.current.set(part.messageID, byPart);
          const combined = buildMessageText(byPart);
          const resolvedRole =
            part.role ?? roleByMessage.current.get(part.messageID);
          if (combined.trim().length > 0 && resolvedRole === "assistant") {
            upsertMessage(
              part.messageID,
              {
                role: resolvedRole,
                text: combined,
                timestamp: part.time?.end
                  ? new Date(part.time.end).toISOString()
                  : new Date().toISOString(),
              },
              { requireText: true },
            );
          }
          if (
            resolvedRole === "assistant" &&
            (normalized.type === "text" || normalized.type === "reasoning")
          ) {
            setStreaming(true);
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
          const timestamp = info.time?.created
            ? new Date(info.time.created).toISOString()
            : new Date().toISOString();
          if (info.role) {
            roleByMessage.current.set(info.id, info.role);
          }
          if (info.role === "user") {
            reconcileUserMessage(info.id, timestamp);
          } else {
            const parts = partsByMessage.current.get(info.id);
            const combined = parts ? buildMessageText(parts) : "";
            upsertMessage(
              info.id,
              {
                role: info.role ?? "assistant",
                text: combined || undefined,
                timestamp,
              },
              { requireText: true },
            );
          }
          if (info.role === "assistant" && info.time?.completed) {
            setStreaming(false);
            refreshToolActivity();
          }
        }
      } catch (err) {
        console.error("[OpenCode] Failed to parse event:", err);
      }
    };

    source.onerror = (err) => {
      console.error("[OpenCode] Event stream error", err);
    };

    return () => {
      source.close();
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
      setError("");
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
      partsByMessage.current.clear();
      setToolActivity([]);
      roleByMessage.current.clear();
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
  ) => {
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
      setMessages(
        sessionMessages
          .filter((msg) => msg.text.trim().length > 0)
          .map((msg) => ({ ...msg, pending: false })),
      );
      if (loadedSession.model) {
        setSelectedModel(loadedSession.model);
        persistModel(loadedSession.model);
      }
      setError("");
    } catch (err) {
      setError(`Failed to load session: ${String(err)}`);
    } finally {
      setLoadingSession(false);
    }
  };

  const handleSendMessage = async (messageText?: string) => {
    const text = (messageText ?? inputMessage).trim();
    if (!text || !currentSession) {
      return;
    }

    const userMessage: ChatMessage = {
      id:
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? `local-${crypto.randomUUID()}`
          : `local-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      role: "user",
      text,
      timestamp: new Date().toISOString(),
      pending: true,
    };

    setMessages((prev) => [...prev, userMessage]);
    setInputMessage("");
    setSending(true);
    setStreaming(true);
    setError("");

    try {
      await opencodeService.sendPromptAsync(
        currentSession.path,
        text,
        selectedModel,
        repoPath,
      );
    } catch (err) {
      setError(`Failed to get response: ${String(err)}`);
      setMessages((prev) => prev.slice(0, -1));
      setStreaming(false);
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
        partsByMessage.current.clear();
        setToolActivity([]);
        roleByMessage.current.clear();
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
      <div className="relative flex h-[min(72vh,720px)] min-h-[420px] flex-col">
        <div className="flex flex-wrap items-start justify-between border-b border-border/60 bg-white/70 px-6 py-2 backdrop-blur">
          <div>
            <div className="text-sm font-semibold text-foreground">
              {currentSession ? currentSession.name : "Start a new session"}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>Repository: {repoPath}</span>
              {selectedModel && (
                <Badge
                  variant="secondary"
                  className="rounded-full px-2 py-0 font-mono text-[0.65rem]"
                >
                  {selectedModel}
                </Badge>
              )}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span
                className={cn(
                  "inline-flex size-2 rounded-full",
                  hasActiveWork
                    ? "bg-amber-500/80 animate-pulse"
                    : "bg-emerald-500/80",
                )}
              />
              <span>{activityLabel}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
              <DialogTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2 rounded-full border-border/60 bg-white/80 px-3 text-xs font-semibold shadow-[var(--shadow-xs)]"
                >
                  <HistoryIcon className="size-4" />
                  History
                  <Badge
                    variant="secondary"
                    className="rounded-full px-2 py-0 text-[0.6rem]"
                  >
                    {sessions.length}
                  </Badge>
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl border border-border/60 bg-gradient-to-br from-white via-[#fbf7f2] to-[#f6efe7] p-0">
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
                      {creatingSession ? "Creating..." : "New session"}
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
              {creatingSession ? "Creating..." : "New session"}
            </Button>
          </div>
        </div>

        <div className="flex flex-1 flex-col min-h-0">
          <div className="flex-1 min-h-0 px-6 pb-6">
            <div>
              <div
                ref={messagesContainerRef}
                className="flex flex-1 min-h-[400px] flex-col gap-6 overflow-y-auto px-6 py-6 h-[calc(100vh-450px)]"
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
                      Start a focused AI session
                    </h3>
                    <p className="mt-2 max-w-md text-sm text-muted-foreground">
                      Create a new session or revisit your history to keep
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
                        {creatingSession ? "Creating..." : "New session"}
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
                      Your session is ready
                    </h3>
                    <p className="mt-2 max-w-md text-sm text-muted-foreground">
                      Ask Falck AI anything. Responses will appear here with
                      full context.
                    </p>
                  </div>
                ) : (
                  visibleMessages.map((msg, idx) => (
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
                      <MessageContent
                        className={cn(
                          "relative rounded-2xl border border-border/60 px-5 py-4 shadow-[var(--shadow-xs)]",
                          "group-[.is-user]:bg-gradient-to-br group-[.is-user]:from-neutral-900 group-[.is-user]:to-neutral-700 group-[.is-user]:text-white",
                          "group-[.is-assistant]:bg-white/80 group-[.is-assistant]:backdrop-blur",
                        )}
                      >
                        <div className="flex items-center justify-between text-[0.6rem] uppercase tracking-[0.3em] opacity-70">
                          <span>
                            {msg.role === "user" ? "You" : "Falck AI"}
                          </span>
                          <span>{formatMessageTime(msg.timestamp)}</span>
                        </div>
                        <MessageResponse className="text-sm leading-relaxed text-foreground/90 group-[.is-user]:text-white">
                          {msg.text}
                        </MessageResponse>
                      </MessageContent>
                    </AIMessage>
                  ))
                )}
                {(sending || streaming) && currentSession && (
                  <AIMessage from="assistant" className="max-w-[80%] gap-3">
                    <MessageContent className="rounded-2xl border border-border/60 bg-white/80 px-5 py-4 shadow-[var(--shadow-xs)]">
                      <div className="flex items-center justify-between text-[0.6rem] uppercase tracking-[0.3em] opacity-70">
                        <span>Falck AI</span>
                        <span>Thinking</span>
                      </div>
                      <div className="text-sm text-muted-foreground">
                        Crafting a response...
                      </div>
                    </MessageContent>
                  </AIMessage>
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
                              <span className="text-muted-foreground/60">•</span>
                              <span className="inline-flex items-center gap-1 text-amber-700">
                                <span className="inline-flex size-1.5 rounded-full bg-amber-500/80 animate-pulse" />
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
