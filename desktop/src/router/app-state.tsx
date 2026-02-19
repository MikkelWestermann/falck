import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { configService } from "@/services/configService";
import { backendService } from "@/services/backendService";
import { falckService } from "@/services/falckService";
import { SSHKey, sshService } from "@/services/sshService";

type AppState = {
  sshReady: boolean;
  sshKey: SSHKey | null;
  setSshKey: (key: SSHKey | null) => void;
  repoPath: string | null;
  setRepoPath: (path: string | null) => void;
};

const AppStateContext = createContext<AppState | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [repoPath, setRepoPath] = useState<string | null>(null);
  const [sshKey, setSshKey] = useState<SSHKey | null>(() =>
    configService.getSelectedSSHKey(),
  );
  const [sshReady, setSshReady] = useState(false);

  useEffect(() => {
    const verifyKey = async () => {
      const stored = configService.getSelectedSSHKey();
      if (!stored) {
        setSshReady(true);
        return;
      }

      try {
        const keys = await sshService.listKeys();
        const match =
          keys.find(
            (key) =>
              key.private_key_path === stored.private_key_path ||
              key.fingerprint === stored.fingerprint,
          ) || null;
        if (match) {
          setSshKey(match);
        } else {
          configService.setSelectedSSHKey(null);
          setSshKey(null);
        }
      } catch {
        setSshKey(stored);
      } finally {
        setSshReady(true);
      }
    };

    void verifyKey();
  }, []);

  useEffect(() => {
    if (!repoPath) {
      return;
    }

    void backendService.ensureRepoBackend(repoPath).catch((err) => {
      console.error("Failed to start virtualized backend:", err);
    });

    return () => {
      void falckService.clearSecrets();
      void backendService.stopRepoBackend(repoPath).catch((err) => {
        console.error("Failed to stop virtualized backend:", err);
      });
    };
  }, [repoPath]);

  const value = useMemo(
    () => ({
      sshReady,
      sshKey,
      setSshKey,
      repoPath,
      setRepoPath,
    }),
    [repoPath, sshKey, sshReady],
  );

  return (
    <AppStateContext.Provider value={value}>
      {children}
    </AppStateContext.Provider>
  );
}

export function useAppState() {
  const context = useContext(AppStateContext);
  if (!context) {
    throw new Error("useAppState must be used within AppStateProvider");
  }
  return context;
}
