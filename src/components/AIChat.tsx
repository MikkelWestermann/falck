import { useEffect, useMemo, useRef, useState } from "react";
import { AISession, Message, Provider, opencodeService } from "../services/opencodeService";

interface AIChatProps {
  repoPath: string;
}

export function AIChat({ repoPath }: AIChatProps) {
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
            | { sessionID?: string; messageID?: string; id?: string; type?: string; text?: string; time?: { start?: number; end?: number } }
            | undefined;
          if (!part || part.sessionID !== currentSession?.path || !part.messageID || !part.id) {
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
            | { id?: string; sessionID?: string; role?: "user" | "assistant"; time?: { created?: number; completed?: number } }
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
      setSelectedModel(
        config.defaults?.openai ||
          config.providers[0]?.models[0] ||
          "gpt-4",
      );
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
    return <div className="ai-shell">Initializing OpenCode…</div>;
  }

  return (
    <div className="ai-shell">
      <aside className="ai-sidebar">
        <div className="ai-sidebar-header">
          <h2>AI sessions</h2>
          <p>Keep separate conversations per task.</p>
        </div>

        <div className="ai-session-list">
          {sessions.length === 0 ? (
            <div className="empty">No sessions yet.</div>
          ) : (
            sessions.map((session) => (
              <div
                key={session.path}
                className={`ai-session-item ${
                  currentSession?.path === session.path ? "active" : ""
                }`}
              >
                <button
                  className="ai-session-main"
                  onClick={() => handleSelectSession(session)}
                >
                  <div>
                    <div className="ai-session-name">{session.name}</div>
                    <div className="ai-session-model">{session.model}</div>
                  </div>
                </button>
                <button
                  className="btn ghost tiny"
                  onClick={() => handleDeleteSession(session)}
                >
                  Delete
                </button>
              </div>
            ))
          )}
        </div>

        <button className="btn primary" onClick={handleCreateSession} disabled={loading}>
          + New session
        </button>

        <div className="field">
          <label>Model</label>
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
          >
            {providers.flatMap((provider) =>
              provider.models.map((model) => (
                <option key={`${provider.name}-${model}`} value={model}>
                  {provider.name}: {model}
                </option>
              )),
            )}
          </select>
        </div>
      </aside>

      <section className="ai-main">
        {!currentSession ? (
          <div className="ai-empty">
            <p>Select a session or create a new one to start chatting.</p>
          </div>
        ) : (
          <>
            <header className="ai-header">
              <div>
                <h2>{currentSession.name}</h2>
                <p>Repository: {repoPath}</p>
              </div>
              <span className="tag">{currentSession.model}</span>
            </header>

            <div className="ai-messages">
              {messages.length === 0 ? (
                <div className="empty">No messages yet. Ask the AI anything.</div>
              ) : (
                messages.map((msg, idx) => (
                  <div key={idx} className={`ai-message ${msg.role}`}>
                    <div className="ai-message-role">
                      {msg.role === "user" ? "You" : "AI"}
                    </div>
                    <div className="ai-message-text">{msg.text}</div>
                    <div className="ai-message-time">
                      {new Date(msg.timestamp).toLocaleTimeString()}
                    </div>
                  </div>
                ))
              )}
              {(sending || streaming) && (
                <div className="ai-message assistant">
                  <div className="ai-message-role">AI</div>
                  <div className="ai-message-text">Thinking…</div>
                </div>
              )}
            </div>

            <div className="ai-input">
              <textarea
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
              <button
                className="btn primary"
                onClick={handleSendMessage}
                disabled={sending || !inputMessage.trim()}
              >
                Send
              </button>
            </div>
          </>
        )}

        {error && <div className="notice error">{error}</div>}
      </section>
    </div>
  );
}
