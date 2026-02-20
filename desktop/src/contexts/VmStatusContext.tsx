import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { backendService, type BackendMode } from "@/services/backendService";
import { useAppState } from "@/router/app-state";

export type VmPhase =
  | "idle"
  | "checking"
  | "starting"
  | "creating"
  | "waiting"
  | "bootstrapping"
  | "ready"
  | "stopping"
  | "stopped"
  | "deleting"
  | "deleted"
  | "error";

export interface VmStatusEvent {
  repo_path: string;
  vm_name?: string | null;
  provider?: string | null;
  phase: VmPhase;
  message: string;
  timestamp_ms: number;
}

interface VmStatusState {
  enabled: boolean;
  repoPath: string | null;
  vmName: string | null;
  provider: string | null;
  phase: VmPhase;
  message: string;
  logs: VmStatusEvent[];
}

interface VmStatusContextValue {
  state: VmStatusState;
  busy: boolean;
  expanded: boolean;
  setExpanded: (value: boolean) => void;
  toggleExpanded: () => void;
  clearLogs: () => void;
}

const VmStatusContext = createContext<VmStatusContextValue | null>(null);

const LOG_LIMIT = 200;
const BUSY_PHASES: VmPhase[] = [
  "checking",
  "starting",
  "creating",
  "waiting",
  "bootstrapping",
  "stopping",
  "deleting",
];

const idleState: VmStatusState = {
  enabled: false,
  repoPath: null,
  vmName: null,
  provider: null,
  phase: "idle",
  message: "",
  logs: [],
};

export function VmStatusProvider({ children }: { children: ReactNode }) {
  const { repoPath } = useAppState();
  const [mode, setMode] = useState<BackendMode>("host");
  const [state, setState] = useState<VmStatusState>(idleState);
  const [expanded, setExpanded] = useState(false);
  const previousRepoRef = useRef<string | null>(null);
  const previousModeRef = useRef<BackendMode>("host");

  useEffect(() => {
    let active = true;
    if (!repoPath) {
      setMode("host");
      setState(idleState);
      setExpanded(false);
      return;
    }

    backendService
      .getMode()
      .then((nextMode) => {
        if (active) {
          setMode(nextMode);
        }
      })
      .catch(() => {
        if (active) {
          setMode("host");
        }
      });

    return () => {
      active = false;
    };
  }, [repoPath]);

  useEffect(() => {
    const previousRepo = previousRepoRef.current;
    const previousMode = previousModeRef.current;
    if (
      previousRepo &&
      previousMode === "virtualized" &&
      (repoPath !== previousRepo || mode !== "virtualized")
    ) {
      backendService.stopRepoBackend(previousRepo).catch(() => {
        // ignore stop errors on navigation/teardown
      });
    }
    previousRepoRef.current = repoPath;
    previousModeRef.current = mode;
  }, [repoPath, mode]);

  useEffect(() => {
    return () => {
      const previousRepo = previousRepoRef.current;
      const previousMode = previousModeRef.current;
      if (previousRepo && previousMode === "virtualized") {
        backendService.stopRepoBackend(previousRepo).catch(() => {
          // ignore stop errors on unmount
        });
      }
    };
  }, []);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let active = true;

    listen<BackendMode>("backend:mode", (event) => {
      if (!active) {
        return;
      }
      if (event.payload) {
        setMode(event.payload);
      }
    })
      .then((stop) => {
        unlisten = stop;
      })
      .catch(() => {
        // ignore
      });

    return () => {
      active = false;
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  useEffect(() => {
    if (!repoPath || mode !== "virtualized") {
      setState((prev) => ({
        ...idleState,
        repoPath: repoPath ?? null,
        enabled: false,
        logs: prev.logs,
      }));
      setExpanded(false);
      return;
    }

    setState({
      enabled: true,
      repoPath,
      vmName: null,
      provider: null,
      phase: "starting",
      message: "Starting virtualized backend...",
      logs: [],
    });
    setExpanded(false);

    let unlisten: UnlistenFn | null = null;
    let active = true;

    listen<VmStatusEvent>("vm:status", (event) => {
      if (!active) {
        return;
      }
      const payload = event.payload;
      if (!payload || payload.repo_path !== repoPath) {
        return;
      }
      setState((prev) => {
        const nextLogs = [...prev.logs, payload].slice(-LOG_LIMIT);
        return {
          enabled: true,
          repoPath,
          vmName: payload.vm_name ?? prev.vmName,
          provider: payload.provider ?? prev.provider,
          phase: payload.phase ?? prev.phase,
          message: payload.message ?? prev.message,
          logs: nextLogs,
        };
      });
      if (payload.phase === "error") {
        setExpanded(true);
      }
    })
      .then((stop) => {
        unlisten = stop;
      })
      .catch(() => {
        // Ignore listen errors; the UI will simply stay idle.
      });

    backendService.ensureRepoBackend(repoPath).catch((err) => {
      if (!active) {
        return;
      }
      setState((prev) => ({
        ...prev,
        phase: "error",
        message: `Virtualized backend failed: ${String(err)}`,
      }));
      setExpanded(true);
    });

    return () => {
      active = false;
      if (unlisten) {
        unlisten();
      }
    };
  }, [repoPath, mode]);

  const value = useMemo(() => {
    const busy = BUSY_PHASES.includes(state.phase);
    return {
      state,
      busy,
      expanded,
      setExpanded,
      toggleExpanded: () => setExpanded((prev) => !prev),
      clearLogs: () => setState((prev) => ({ ...prev, logs: [] })),
    } as VmStatusContextValue;
  }, [state, expanded]);

  return (
    <VmStatusContext.Provider value={value}>
      {children}
    </VmStatusContext.Provider>
  );
}

export function useVmStatus() {
  const context = useContext(VmStatusContext);
  if (!context) {
    throw new Error("useVmStatus must be used within VmStatusProvider");
  }
  return context;
}
