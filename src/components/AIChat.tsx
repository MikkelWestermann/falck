import { useEffect, useMemo, useRef, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
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

export function AIChat({ repoPath }: AIChatProps) {
  const MODEL_STORAGE_KEY = "falck.opencode.model";
  const [sessions, setSessions] = useState<AISession[]>([]);
  const [currentSession, setCurrentSession] = useState<AISession | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [selectedModel, setSelectedModel] = useState("gpt-4");
  const [inputMessage, setInputMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");
  const [initializing, setInitializing] = useState(true);
  const partsByMessage = useRef<Map<string, Map<string, string>>>(new Map());

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

  useEffect(() => {
    void initializeOpenCode();
  }, []);

  useEffect(() => {
    if (!repoPath) {
      return;
    }

    const source = new EventSource(eventStreamUrl);

    const upsertMessage = (messageId: string, updates: Partial<Message>) => {
      setMessages((prev) => {
        const idx = prev.findIndex((msg) => msg.id === messageId);
        if (idx === -1) {
          return [
            ...prev,
            {
              id: messageId,
              role: updates.role ?? "assistant",
              text: updates.text ?? "",
              timestamp: updates.timestamp ?? new Date().toISOString(),
            },
          ];
        }
        const next = [...prev];
        next[idx] = { ...next[idx], ...updates, id: messageId };
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
          if (part.type === "text") {
            setStreaming(true);
            const byPart = partsByMessage.current.get(part.messageID) ?? new Map();
            byPart.set(part.id, part.text ?? "");
            partsByMessage.current.set(part.messageID, byPart);
            const combined = Array.from(byPart.values()).filter(Boolean).join("\n");
            upsertMessage(part.messageID, {
              role: "assistant",
              text: combined,
              timestamp: part.time?.end
                ? new Date(part.time.end).toISOString()
                : new Date().toISOString(),
            });
          }
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
          upsertMessage(info.id, {
            role: info.role ?? "assistant",
            timestamp: info.time?.created
              ? new Date(info.time.created).toISOString()
              : new Date().toISOString(),
          });
          if (info.role === "assistant" && info.time?.completed) {
            setStreaming(false);
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
      const availableModels = config.providers.flatMap((provider) => provider.models);
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

  const handleCreateSession = async () => {
    const name = `AI Session - ${new Date().toLocaleString()}`;
    setLoading(true);
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
      setError("");
    } catch (err) {
      setError(`Failed to create session: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectSession = async (session: AISession) => {
    setLoading(true);
    try {
      const loadedSession = await opencodeService.getSession(session.path, repoPath);
      setCurrentSession(loadedSession);
      const sessionMessages = await opencodeService.listMessages(session.path, repoPath);
      setMessages(sessionMessages);
      setError("");
    } catch (err) {
      setError(`Failed to load session: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleSendMessage = async () => {
    if (!inputMessage.trim() || !currentSession) {
      return;
    }

    const userMessage: Message = {
      role: "user",
      text: inputMessage,
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInputMessage("");
    setSending(true);
    setStreaming(true);
    setError("");

    try {
      await opencodeService.sendPromptAsync(
        currentSession.path,
        inputMessage,
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
      }
      setError("");
    } catch (err) {
      setError(`Failed to delete session: ${String(err)}`);
    }
  };

  if (initializing) {
    return (
      <div className="rounded-2xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
        Initializing OpenCode…
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
      <Card className="flex h-full flex-col">
        <CardHeader>
          <CardTitle>AI sessions</CardTitle>
          <CardDescription>Keep separate conversations per task.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col gap-4">
          <div className="flex items-center justify-between gap-2">
            <Button onClick={handleCreateSession} disabled={loading} className="w-full">
              + New session
            </Button>
          </div>

          <div className="space-y-2 overflow-y-auto pr-1" style={{ maxHeight: 360 }}>
            {sessions.length === 0 ? (
              <div className="rounded-2xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                No sessions yet.
              </div>
            ) : (
              sessions.map((session) => (
                <div
                  key={session.path}
                  className={cn(
                    "flex items-center justify-between gap-2 rounded-2xl border px-3 py-2",
                    currentSession?.path === session.path
                      ? "border-primary/40 bg-secondary/80"
                      : "border-border/60 bg-card/80",
                  )}
                >
                  <button
                    className="flex-1 text-left"
                    onClick={() => handleSelectSession(session)}
                  >
                    <div className="text-sm font-semibold text-foreground">
                      {session.name}
                    </div>
                    <div className="text-xs text-muted-foreground">{session.model}</div>
                  </button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDeleteSession(session)}
                  >
                    Delete
                  </Button>
                </div>
              ))
            )}
          </div>

          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.25em] text-muted-foreground">
              Model
            </p>
            <Select
              value={selectedModel}
              onValueChange={(value) => {
                setSelectedModel(value);
                persistModel(value);
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select model" />
              </SelectTrigger>
              <SelectContent>
                {providers.flatMap((provider) =>
                  provider.models.map((model) => (
                    <SelectItem key={`${provider.name}-${model}`} value={model}>
                      {provider.name}: {model}
                    </SelectItem>
                  )),
                )}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card className="flex min-h-[560px] flex-col">
        {!currentSession ? (
          <CardContent className="flex flex-1 items-center justify-center">
            <div className="text-center text-sm text-muted-foreground">
              Select a session or create a new one to start chatting.
            </div>
          </CardContent>
        ) : (
          <>
            <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle>{currentSession.name}</CardTitle>
                <CardDescription>Repository: {repoPath}</CardDescription>
              </div>
              <Badge variant="secondary" className="w-fit rounded-full">
                {currentSession.model}
              </Badge>
            </CardHeader>
            <CardContent className="flex-1 overflow-hidden pt-0">
              <div className="flex h-full flex-col gap-3 overflow-y-auto pr-2">
                {messages.length === 0 ? (
                  <div className="rounded-2xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                    No messages yet. Ask the AI anything.
                  </div>
                ) : (
                  messages.map((msg, idx) => (
                    <div
                      key={idx}
                      className={cn(
                        "max-w-[75%] rounded-2xl px-4 py-3 text-sm",
                        msg.role === "user"
                          ? "ml-auto bg-primary text-primary-foreground"
                          : "mr-auto border border-border/60 bg-card",
                      )}
                    >
                      <div className="mb-1 text-[0.65rem] uppercase tracking-[0.25em] opacity-70">
                        {msg.role === "user" ? "You" : "AI"}
                      </div>
                      <div className="whitespace-pre-wrap leading-relaxed">
                        {msg.text}
                      </div>
                      <div className="mt-2 text-[0.65rem] opacity-60">
                        {new Date(msg.timestamp).toLocaleTimeString()}
                      </div>
                    </div>
                  ))
                )}
                {(sending || streaming) && (
                  <div className="mr-auto max-w-[75%] rounded-2xl border border-border/60 bg-card px-4 py-3 text-sm">
                    <div className="mb-1 text-[0.65rem] uppercase tracking-[0.25em] opacity-70">
                      AI
                    </div>
                    <div className="leading-relaxed">Thinking…</div>
                  </div>
                )}
              </div>
            </CardContent>
            <div className="border-t border-border/60 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <Textarea
                  rows={3}
                  value={inputMessage}
                  onChange={(e) => setInputMessage(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.ctrlKey && e.key === "Enter") {
                      handleSendMessage();
                    }
                  }}
                  placeholder="Ask Falck AI… (Ctrl+Enter to send)"
                />
                <Button
                  onClick={handleSendMessage}
                  disabled={sending || !inputMessage.trim()}
                  className="sm:w-32"
                >
                  Send
                </Button>
              </div>
            </div>
          </>
        )}

        {error && (
          <div className="p-4 pt-0">
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </div>
        )}
      </Card>
    </div>
  );
}
