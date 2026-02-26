import { useCallback, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { configService } from "@/services/configService";
import { backendService, BackendMode, BackendPrereqStatus } from "@/services/backendService";
import { githubKeys, sshKeys } from "@/queries/keys";
import { useGithubHasToken, useGithubUser } from "@/queries/github";
import { useSshKeys, useSshOs } from "@/queries/ssh";
import {
  githubService,
  type GithubDeviceResponse,
} from "@/services/githubService";
import {
  opencodeService,
  type OpenCodeProviderList,
  type OpenCodeStatus,
} from "@/services/opencodeService";
import { falckService } from "@/services/falckService";
import { KeyType, SSHKey, sshService } from "@/services/sshService";

export function useGithubSetup() {
  const queryClient = useQueryClient();
  const [device, setDevice] = useState<GithubDeviceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const githubTokenQuery = useGithubHasToken();
  const hasGithubToken = Boolean(githubTokenQuery.data);
  const githubUserQuery = useGithubUser(hasGithubToken);
  const tokenError = githubUserQuery.error;
  const tokenInvalid = tokenError
    ? String(tokenError).toLowerCase().includes("token")
    : false;
  const connected = hasGithubToken && !tokenInvalid;
  const user = githubUserQuery.data ?? null;
  const checking = githubTokenQuery.isLoading;
  const queryError = githubTokenQuery.error
    ? `GitHub auth unavailable: ${String(githubTokenQuery.error)}`
    : githubUserQuery.error
      ? String(githubUserQuery.error)
      : null;
  const errorMessage = error ?? queryError;

  const connectMutation = useMutation({
    mutationFn: async () => {
      const nextDevice = await githubService.startDeviceFlow();
      setDevice(nextDevice);
      await falckService.openInBrowser(
        nextDevice.verification_uri_complete ?? nextDevice.verification_uri,
      );
      await githubService.pollDeviceToken(
        nextDevice.device_code,
        nextDevice.interval,
        nextDevice.expires_in,
      );
    },
    onSuccess: async () => {
      setDevice(null);
      setError(null);
      await queryClient.invalidateQueries({ queryKey: githubKeys.all });
    },
    onError: (err) => {
      setDevice(null);
      setError(`GitHub login failed: ${String(err)}`);
    },
  });

  const refresh = useCallback(async () => {
    setError(null);
    await queryClient.invalidateQueries({ queryKey: githubKeys.all });
  }, [queryClient]);

  const connect = useCallback(() => {
    setError(null);
    connectMutation.mutate();
  }, [connectMutation]);

  return {
    connected,
    user,
    device,
    checking,
    working: connectMutation.isPending,
    error: errorMessage,
    refresh,
    connect,
  };
}

interface UseSshSetupOptions {
  initialKey: SSHKey | null;
  setSshKey: (key: SSHKey | null) => void;
}

export function useSshSetup({ initialKey, setSshKey }: UseSshSetupOptions) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<SSHKey | null>(initialKey);
  const [manualConfirmed, setManualConfirmed] = useState(false);
  const [keyAdded, setKeyAdded] = useState(false);
  const [copyState, setCopyState] = useState(false);
  const [creatingKey, setCreatingKey] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [agentWorking, setAgentWorking] = useState(false);
  const [agentMessage, setAgentMessage] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);

  const keysQuery = useSshKeys();
  const osQuery = useSshOs();
  const keys = keysQuery.data ?? [];
  const loading = keysQuery.isLoading;
  const keysError = keysQuery.error
    ? `Failed to load SSH keys: ${String(keysQuery.error)}`
    : null;
  const errorMessage = error ?? keysError;
  const os = osQuery.data ?? "unknown";

  const refreshKeys = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: sshKeys.list() });
  }, [queryClient]);

  const refreshOs = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: sshKeys.os() });
  }, [queryClient]);

  const selectKey = useCallback(
    (key: SSHKey) => {
      setSelectedKey(key);
      setSshKey(key);
      configService.setSelectedSSHKey(key);
      setKeyAdded(false);
      setManualConfirmed(false);
      setCopyState(false);
      setAgentMessage(null);
      setAgentError(null);
    },
    [setSshKey],
  );

  const createKey = useCallback(
    async ({
      name,
      type,
      passphrase,
      confirm,
    }: {
      name: string;
      type: KeyType;
      passphrase: string;
      confirm: string;
    }) => {
      setCreateError(null);
      setAgentMessage(null);
      setAgentError(null);
      if (!name.trim()) {
        setCreateError("Key name is required.");
        return;
      }
      if (passphrase && passphrase !== confirm) {
        setCreateError("Passphrases do not match.");
        return;
      }
      setCreatingKey(true);
      try {
        const key = await sshService.generateNewKey(
          name.trim(),
          passphrase ? passphrase : null,
          type,
        );
        setSelectedKey(key);
        setSshKey(key);
        configService.setSelectedSSHKey(key);
        queryClient.setQueryData<SSHKey[]>(sshKeys.list(), (prev) => [
          key,
          ...(prev ?? []),
        ]);
        setKeyAdded(false);
        setManualConfirmed(false);
      } catch (err) {
        setCreateError(`Failed to generate key: ${String(err)}`);
      } finally {
        setCreatingKey(false);
      }
    },
    [setSshKey],
  );

  const clearSelection = useCallback(() => {
    setSelectedKey(null);
    setSshKey(null);
    configService.setSelectedSSHKey(null);
    setKeyAdded(false);
    setManualConfirmed(false);
    setCopyState(false);
    setAgentMessage(null);
    setAgentError(null);
  }, [setSshKey]);

  const copyKey = useCallback(() => {
    if (!selectedKey) {
      return;
    }
    navigator.clipboard
      .writeText(selectedKey.public_key)
      .then(() => {
        setCopyState(true);
        setTimeout(() => setCopyState(false), 2000);
      })
      .catch(() => {
        setCopyState(false);
      });
  }, [selectedKey]);

  const addKeyMutation = useMutation({
    mutationFn: async (key: SSHKey) => {
      try {
        await githubService.addSshKey(`Falck - ${key.name}`, key.public_key);
      } catch (err) {
        const message = String(err);
        const lowered = message.toLowerCase();
        if (
          lowered.includes("already exists") ||
          lowered.includes("already in use")
        ) {
          return;
        }
        throw err;
      }
    },
    onSuccess: () => {
      setKeyAdded(true);
      setError(null);
    },
    onError: (err) => {
      setError(`Failed to add key to GitHub: ${String(err)}`);
    },
  });

  const addingKey = addKeyMutation.isPending;

  const addKeyToGithub = useCallback(async () => {
    if (!selectedKey) {
      return;
    }
    setError(null);
    await addKeyMutation.mutateAsync(selectedKey);
  }, [addKeyMutation, selectedKey]);

  const addToAgent = useCallback(
    async (passphrase: string) => {
      if (!selectedKey) {
        return;
      }
      setAgentWorking(true);
      setAgentMessage(null);
      setAgentError(null);
      try {
        await sshService.addKeyToAgent(
          selectedKey.private_key_path,
          passphrase ? passphrase : null,
        );
        setAgentMessage("Key added to SSH agent.");
      } catch (err) {
        setAgentError(`Failed to add key to SSH agent: ${String(err)}`);
      } finally {
        setAgentWorking(false);
      }
    },
    [selectedKey],
  );

  const instructions = useMemo(() => {
    if (!selectedKey) {
      return null;
    }
    const publicKeyPath = selectedKey.private_key_path.endsWith(".pub")
      ? selectedKey.private_key_path
      : `${selectedKey.private_key_path}.pub`;
    return sshService.getSetupInstructions(os, publicKeyPath);
  }, [os, selectedKey]);

  const ready = Boolean(selectedKey) && (keyAdded || manualConfirmed);

  return {
    keys,
    loading,
    error: errorMessage,
    selectedKey,
    manualConfirmed,
    keyAdded,
    copyState,
    addingKey,
    os,
    creatingKey,
    createError,
    agentWorking,
    agentMessage,
    agentError,
    instructions,
    ready,
    setManualConfirmed,
    selectKey,
    clearSelection,
    refreshKeys,
    refreshOs,
    createKey,
    copyKey,
    addKeyToGithub,
    addToAgent,
  };
}

export function useBackendSetup() {
  const [mode, setMode] = useState<BackendMode | null>(null);
  const [prereq, setPrereq] = useState<BackendPrereqStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const status = await backendService.checkPrereq();
      setPrereq(status);
      if (!mode) {
        const preferred: BackendMode = status.installed ? "virtualized" : "host";
        setMode(preferred);
        await backendService.setMode(preferred);
      }
    } catch (err) {
      setError(`Failed to load workspace settings: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [mode]);

  const selectMode = useCallback(async (nextMode: BackendMode) => {
    setMode(nextMode);
    setSaving(true);
    setError(null);
    try {
      await backendService.setMode(nextMode);
    } catch (err) {
      setError(`Failed to update workspace mode: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  }, []);

  return {
    mode,
    prereq,
    loading,
    saving,
    error,
    refresh,
    selectMode,
  };
}

export function useOpenCodeSetup() {
  const [status, setStatus] = useState<OpenCodeStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [providers, setProviders] = useState<OpenCodeProviderList | null>(null);
  const [providerLoading, setProviderLoading] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      const nextStatus = await opencodeService.checkInstalled();
      setStatus(nextStatus);
    } catch (err) {
      setError(`Failed to check OpenCode: ${String(err)}`);
    } finally {
      setChecking(false);
    }
  }, []);

  const refreshProviders = useCallback(async () => {
    setProviderLoading(true);
    setProviderError(null);
    try {
      const list = await opencodeService.listProviderCatalog();
      setProviders(list);
    } catch (err) {
      setProviderError(`Failed to load providers: ${String(err)}`);
      setProviders(null);
    } finally {
      setProviderLoading(false);
    }
  }, []);

  const install = useCallback(async () => {
    setInstalling(true);
    setError(null);
    setMessage(null);
    setManual(false);
    try {
      const result = await opencodeService.install();
      if (result.requiresManualInstall) {
        setManual(true);
        setMessage(result.message);
        await opencodeService.openWindowsInstaller();
        return;
      }
      if (result.success) {
        setMessage(result.message);
        await refreshStatus();
        return;
      }
      setError(result.message);
    } catch (err) {
      setError(`Installation failed: ${String(err)}`);
    } finally {
      setInstalling(false);
    }
  }, [refreshStatus]);

  const connectedProviders = useMemo(() => {
    if (!providers) {
      return [] as string[];
    }
    const byId = new Map(providers.all.map((item) => [item.id, item]));
    return providers.connected.map((id) => byId.get(id)?.name ?? id);
  }, [providers]);

  return {
    status,
    checking,
    installing,
    error,
    message,
    manual,
    providers,
    providerLoading,
    providerError,
    connectedProviders,
    refreshStatus,
    refreshProviders,
    install,
  };
}
