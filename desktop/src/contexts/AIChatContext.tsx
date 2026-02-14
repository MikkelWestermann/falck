import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  AISession,
  Message,
  Provider,
  opencodeService,
} from "@/services/opencodeService";

export type ChatMessage = Omit<Message, "id"> & {
  id: string;
  pending?: boolean;
};

type AIChatContextValue = {
  repoPath: string;
  sessions: AISession[];
  currentSession: AISession | null;
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  providers: Provider[];
  selectedModel: string;
  setSelectedModel: (model: string) => void;
  serverUrl: string;
  historyOpen: boolean;
  setHistoryOpen: (open: boolean) => void;
  creatingSession: boolean;
  loadingSession: boolean;
  createSession: (options?: { closeHistory?: boolean }) => Promise<void>;
  selectSession: (
    session: AISession,
    options?: { closeHistory?: boolean },
  ) => Promise<boolean>;
  deleteSession: (session: AISession) => Promise<void>;
  sortedSessions: AISession[];
  formatSessionTime: (value: string) => string;
  initializing: boolean;
  error: string;
  setError: (error: string) => void;
};

const AIChatContext = createContext<AIChatContextValue | null>(null);

const MODEL_STORAGE_KEY = "falck.opencode.model";

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
    // ignore
  }
};

const compareMessageId = (a: string, b: string) =>
  a < b ? -1 : a > b ? 1 : 0;

export function AIChatProvider({
  repoPath,
  children,
}: {
  repoPath: string;
  children: React.ReactNode;
}) {
  const [sessions, setSessions] = useState<AISession[]>([]);
  const [currentSession, setCurrentSession] = useState<AISession | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [selectedModel, setSelectedModel] = useState("gpt-4");
  const [serverUrl, setServerUrl] = useState("http://127.0.0.1:4096");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [loadingSession, setLoadingSession] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [error, setError] = useState("");

  const formatSessionTime = useCallback(
    (value: string) => new Date(value).toLocaleString(),
    [],
  );

  const sortedSessions = useMemo(
    () =>
      [...sessions].sort(
        (a, b) => new Date(b.created).getTime() - new Date(a.created).getTime(),
      ),
    [sessions],
  );

  const selectSession = useCallback(
    async (
      session: AISession,
      options?: { closeHistory?: boolean },
    ): Promise<boolean> => {
      if (options?.closeHistory) {
        setHistoryOpen(false);
      }
      setLoadingSession(true);
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
    },
    [repoPath],
  );

  const createSession = useCallback(
    async (options?: { closeHistory?: boolean }) => {
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
        setError("");
      } catch (err) {
        setError(`Failed to create session: ${String(err)}`);
      } finally {
        setCreatingSession(false);
      }
    },
    [repoPath, selectedModel],
  );

  const deleteSession = useCallback(
    async (session: AISession) => {
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
    },
    [repoPath, currentSession?.path],
  );

  useEffect(() => {
    let active = true;

    const init = async () => {
      setInitializing(true);
      try {
        await opencodeService.health(repoPath);
        const info = await opencodeService.getServerInfo();
        if (active && info?.baseUrl) {
          setServerUrl(info.baseUrl);
        }
        const config = await opencodeService.getProviders(repoPath);
        if (!active) return;
        setProviders(config.providers);
        const availableModels = config.providers.flatMap(
          (p) => p.models,
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
        if (!active) return;
        setSessions(sessionList);

        if (sessionList.length > 0) {
          const latestSession = [...sessionList].sort((a, b) => {
            const aTime = new Date(a.created).getTime();
            const bTime = new Date(b.created).getTime();
            return bTime - aTime;
          })[0];
          if (latestSession) {
            await selectSession(latestSession);
          }
        } else {
          const name = `AI Session - ${new Date().toLocaleString()}`;
          const session = await opencodeService.createSession(
            name,
            `Chat session for ${repoPath}`,
            nextModel,
            repoPath,
          );
          if (!active) return;
          setSessions([session]);
          setCurrentSession(session);
          setMessages([]);
        }
        setError("");
      } catch (err) {
        setError(`Failed to initialize OpenCode: ${String(err)}`);
      } finally {
        if (active) {
          setInitializing(false);
        }
      }
    };

    void init();
    return () => {
      active = false;
    };
  }, [repoPath, selectSession]);

  const value = useMemo<AIChatContextValue>(
    () => ({
      repoPath,
      sessions,
      currentSession,
      messages,
      setMessages,
      providers,
      selectedModel,
      serverUrl,
      setSelectedModel: (model) => {
        setSelectedModel(model);
        persistModel(model);
      },
      historyOpen,
      setHistoryOpen,
      creatingSession,
      loadingSession,
      createSession,
      selectSession,
      deleteSession,
      sortedSessions,
      formatSessionTime,
      initializing,
      error,
      setError,
    }),
    [
      repoPath,
      sessions,
      currentSession,
      messages,
      providers,
      selectedModel,
      serverUrl,
      historyOpen,
      creatingSession,
      loadingSession,
      createSession,
      selectSession,
      deleteSession,
      sortedSessions,
      formatSessionTime,
      initializing,
      error,
    ],
  );

  return (
    <AIChatContext.Provider value={value}>{children}</AIChatContext.Provider>
  );
}

export function useAIChat() {
  const ctx = useContext(AIChatContext);
  if (!ctx) {
    throw new Error("useAIChat must be used within AIChatProvider");
  }
  return ctx;
}
