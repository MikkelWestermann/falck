import { useEffect, useState } from "react";
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
  const [error, setError] = useState("");
  const [initializing, setInitializing] = useState(true);

  useEffect(() => {
    void initializeOpenCode();
  }, []);

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
    setLoading(true);
    setError("");

    try {
      const result = await opencodeService.sendPrompt(
        currentSession.path,
        inputMessage,
        selectedModel,
        repoPath,
      );

      const assistantMessage: Message = {
        role: "assistant",
        text: result.response,
        timestamp: result.timestamp,
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (err) {
      setError(`Failed to get response: ${String(err)}`);
      setMessages((prev) => prev.slice(0, -1));
    } finally {
      setLoading(false);
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
              {loading && (
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
                disabled={loading}
              />
              <button
                className="btn primary"
                onClick={handleSendMessage}
                disabled={loading || !inputMessage.trim()}
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
