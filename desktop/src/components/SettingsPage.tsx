import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

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
import { OpenCodeInstallPanel } from "@/components/OpenCodeManager";
import { OpenCodeSettingsPanel } from "@/components/OpenCodeSettings";
import { falckService } from "@/services/falckService";
import {
  GithubDeviceResponse,
  GithubUser,
  githubService,
} from "@/services/githubService";
import {
  backendService,
  BackendMode,
  BackendPrereqStatus,
  BackendVmInfo,
} from "@/services/backendService";
import { settingsService } from "@/services/settingsService";
import { SSHKey } from "@/services/sshService";
import { cn } from "@/lib/utils";
import { ArrowLeft } from "lucide-react";

interface SettingsPageProps {
  sshKey: SSHKey;
  repoPath?: string | null;
  onManageSSHKey: () => void;
  onClose: () => void;
  onOpenRepo?: (path: string) => void;
}

function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn("animate-pulse rounded-lg bg-muted/60", className)} />
  );
}

export function SettingsPage({
  sshKey,
  repoPath,
  onManageSSHKey,
  onClose,
  onOpenRepo,
}: SettingsPageProps) {
  const [defaultRepoDir, setDefaultRepoDir] = useState<string | null>(null);
  const [repoDirLoading, setRepoDirLoading] = useState(true);
  const [repoDirError, setRepoDirError] = useState<string | null>(null);
  const [repoDirSaving, setRepoDirSaving] = useState(false);
  const [githubConnected, setGithubConnected] = useState(false);
  const [githubUser, setGithubUser] = useState<GithubUser | null>(null);
  const [githubDevice, setGithubDevice] = useState<GithubDeviceResponse | null>(
    null,
  );
  const [githubWorking, setGithubWorking] = useState(false);
  const [githubChecking, setGithubChecking] = useState(true);
  const [githubError, setGithubError] = useState<string | null>(null);
  const [openCodeReady, setOpenCodeReady] = useState(false);
  const [backendMode, setBackendMode] = useState<BackendMode>("host");
  const [backendLoading, setBackendLoading] = useState(true);
  const [backendSaving, setBackendSaving] = useState(false);
  const [backendChecking, setBackendChecking] = useState(false);
  const [backendInstalling, setBackendInstalling] = useState(false);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [backendPrereq, setBackendPrereq] =
    useState<BackendPrereqStatus | null>(null);
  const [backendInstallMessage, setBackendInstallMessage] = useState<
    string | null
  >(null);
  const [backendResetting, setBackendResetting] = useState(false);
  const [backendResetMessage, setBackendResetMessage] = useState<string | null>(
    null,
  );
  const [pendingVirtualized, setPendingVirtualized] = useState(false);
  const [vmList, setVmList] = useState<BackendVmInfo[]>([]);
  const [vmLoading, setVmLoading] = useState(true);
  const [vmRefreshing, setVmRefreshing] = useState(false);
  const [vmError, setVmError] = useState<string | null>(null);
  const [vmAction, setVmAction] = useState<Record<string, "stopping" | "deleting" | null>>({});

  useEffect(() => {
    let mounted = true;
    const loadDefaultDir = async () => {
      setRepoDirLoading(true);
      try {
        const dir = await settingsService.getDefaultRepoDir();
        if (mounted) {
          setDefaultRepoDir(dir);
        }
      } catch (err) {
        if (mounted) {
          setRepoDirError(`Failed to load default folder: ${String(err)}`);
        }
      } finally {
        if (mounted) {
          setRepoDirLoading(false);
        }
      }
    };
    void loadDefaultDir();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setGithubChecking(true);
    githubService
      .hasToken()
      .then((hasToken) => {
        if (!active) {
          return;
        }
        setGithubConnected(hasToken);
        if (hasToken) {
          githubService
            .getUser()
            .then((user) => {
              if (active) {
                setGithubUser(user);
              }
            })
            .catch(() => {
              if (active) {
                setGithubUser(null);
              }
            });
        }
      })
      .catch((err) => {
        if (!active) {
          return;
        }
        setGithubConnected(false);
        setGithubError(`GitHub auth unavailable: ${String(err)}`);
      })
      .finally(() => {
        if (active) {
          setGithubChecking(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const win = window as Window & {
      requestIdleCallback?: (
        cb: () => void,
        options?: { timeout: number },
      ) => number;
      cancelIdleCallback?: (id: number) => void;
    };

    if (win.requestIdleCallback) {
      const id = win.requestIdleCallback(() => setOpenCodeReady(true), {
        timeout: 1200,
      });
      return () => win.cancelIdleCallback?.(id);
    }

    const id = window.setTimeout(() => setOpenCodeReady(true), 300);
    return () => window.clearTimeout(id);
  }, []);

  const checkBackendPrereq = async () => {
    setBackendChecking(true);
    try {
      const status = await backendService.checkPrereq();
      setBackendPrereq(status);
      return status;
    } catch (err) {
      setBackendError(`Backend check failed: ${String(err)}`);
      return null;
    } finally {
      setBackendChecking(false);
    }
  };

  useEffect(() => {
    let active = true;
    const loadBackend = async () => {
      setBackendLoading(true);
      try {
        const mode = await backendService.getMode();
        if (!active) {
          return;
        }
        setBackendMode(mode);
        if (mode === "virtualized") {
          setBackendChecking(true);
          try {
            const status = await backendService.checkPrereq();
            if (active) {
              setBackendPrereq(status);
            }
          } finally {
            if (active) {
              setBackendChecking(false);
            }
          }
        }
      } catch (err) {
        if (active) {
          setBackendError(`Failed to load backend setting: ${String(err)}`);
        }
      } finally {
        if (active) {
          setBackendLoading(false);
        }
      }
    };
    void loadBackend();
    return () => {
      active = false;
    };
  }, []);

  const handleBackendChange = async (value: BackendMode) => {
    if (backendSaving || backendInstalling) {
      return;
    }
    setBackendError(null);
    setBackendInstallMessage(null);
    setBackendResetMessage(null);
    setPendingVirtualized(false);
    setBackendSaving(true);
    try {
      if (value === "host") {
        await backendService.setMode("host");
        setBackendMode("host");
        if (repoPath) {
          await backendService.stopRepoBackend(repoPath);
        }
        return;
      }

      const prereq = await checkBackendPrereq();
      if (!prereq?.installed) {
        setPendingVirtualized(true);
        return;
      }
      await backendService.setMode("virtualized");
      setBackendMode("virtualized");
      if (repoPath) {
        await backendService.ensureRepoBackend(repoPath);
      }
    } catch (err) {
      setBackendError(`Failed to update backend: ${String(err)}`);
    } finally {
      setBackendSaving(false);
    }
  };

  const handleInstallBackend = async () => {
    if (backendInstalling) {
      return;
    }
    setBackendError(null);
    setBackendInstallMessage(null);
    setBackendResetMessage(null);
    setBackendInstalling(true);
    try {
      const message = await backendService.installPrereq();
      setBackendInstallMessage(message);
      const status = await checkBackendPrereq();
      if (status?.installed) {
        await backendService.setMode("virtualized");
        setBackendMode("virtualized");
        setPendingVirtualized(false);
        if (repoPath) {
          await backendService.ensureRepoBackend(repoPath);
        }
      }
    } catch (err) {
      setBackendError(`Failed to install backend: ${String(err)}`);
    } finally {
      setBackendInstalling(false);
    }
  };

  const handleResetBackend = async () => {
    if (!repoPath || backendResetting) {
      return;
    }
    const confirmReset = window.confirm(
      "Delete the virtualized backend for this repo? It will be recreated next time you open the repo.",
    );
    if (!confirmReset) {
      return;
    }
    setBackendError(null);
    setBackendResetMessage(null);
    setBackendResetting(true);
    try {
      await backendService.deleteRepoBackend(repoPath);
      setBackendResetMessage("Virtualized backend deleted for this repo.");
    } catch (err) {
      setBackendError(`Failed to delete backend: ${String(err)}`);
    } finally {
      setBackendResetting(false);
    }
  };

  const backendSelectDisabled =
    backendLoading || backendSaving || backendInstalling;
  const showBackendInstallPrompt =
    pendingVirtualized ||
    (backendMode === "virtualized" &&
      backendPrereq &&
      !backendPrereq.installed);

  const handleGithubConnect = async () => {
    setGithubError(null);
    setGithubWorking(true);
    try {
      const device = await githubService.startDeviceFlow();
      setGithubDevice(device);
      await falckService.openInBrowser(
        device.verification_uri_complete ?? device.verification_uri,
      );
      await githubService.pollDeviceToken(
        device.device_code,
        device.interval,
        device.expires_in,
      );
      setGithubConnected(true);
      setGithubDevice(null);
      try {
        const user = await githubService.getUser();
        setGithubUser(user);
      } catch {
        setGithubUser(null);
      }
    } catch (err) {
      setGithubConnected(false);
      setGithubDevice(null);
      setGithubError(`GitHub login failed: ${String(err)}`);
    } finally {
      setGithubWorking(false);
    }
  };

  const handleGithubDisconnect = async () => {
    setGithubError(null);
    setGithubWorking(true);
    try {
      await githubService.clearToken();
      setGithubConnected(false);
      setGithubUser(null);
      setGithubDevice(null);
    } catch (err) {
      setGithubError(`Failed to disconnect: ${String(err)}`);
    } finally {
      setGithubWorking(false);
    }
  };

  const handlePickRepoDir = async () => {
    setRepoDirError(null);
    setRepoDirSaving(true);
    try {
      const selection = await open({
        directory: true,
        multiple: false,
        defaultPath: defaultRepoDir ?? undefined,
        title: "Choose default clone folder",
      });
      if (!selection) {
        return;
      }
      const selectedPath = Array.isArray(selection) ? selection[0] : selection;
      if (!selectedPath) {
        return;
      }
      await settingsService.setDefaultRepoDir(selectedPath);
      setDefaultRepoDir(selectedPath);
    } catch (err) {
      setRepoDirError(`Failed to update folder: ${String(err)}`);
    } finally {
      setRepoDirSaving(false);
    }
  };

  const loadVms = async (refresh = false) => {
    if (refresh) {
      setVmRefreshing(true);
    } else {
      setVmLoading(true);
    }
    setVmError(null);
    try {
      const vms = await backendService.listVms();
      setVmList(vms);
    } catch (err) {
      setVmError(`Failed to load VMs: ${String(err)}`);
    } finally {
      setVmLoading(false);
      setVmRefreshing(false);
    }
  };

  useEffect(() => {
    void loadVms();
  }, []);

  const handleStopVm = async (vm: BackendVmInfo) => {
    if (vmAction[vm.name]) {
      return;
    }
    setVmAction((prev) => ({ ...prev, [vm.name]: "stopping" }));
    setVmError(null);
    try {
      await backendService.stopVm(vm.name);
      await loadVms(true);
    } catch (err) {
      setVmError(`Failed to stop VM ${vm.name}: ${String(err)}`);
    } finally {
      setVmAction((prev) => ({ ...prev, [vm.name]: null }));
    }
  };

  const handleDeleteVm = async (vm: BackendVmInfo) => {
    if (vmAction[vm.name]) {
      return;
    }
    const confirmed = window.confirm(
      `Delete VM ${vm.name}? Any running processes inside it will stop.`,
    );
    if (!confirmed) {
      return;
    }
    setVmAction((prev) => ({ ...prev, [vm.name]: "deleting" }));
    setVmError(null);
    try {
      await backendService.deleteVm(vm.name);
      await loadVms(true);
    } catch (err) {
      setVmError(`Failed to delete VM ${vm.name}: ${String(err)}`);
    } finally {
      setVmAction((prev) => ({ ...prev, [vm.name]: null }));
    }
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-page-background text-foreground">
      <div className="relative mx-auto flex max-w-6xl flex-col gap-8 px-6 py-10 lg:py-14">
        <header
          className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between animate-in fade-in slide-in-from-bottom-4"
          style={{ animationDuration: "600ms" }}
        >
          <div className="space-y-4">
            <div className="space-y-2">
              <h1 className="text-3xl font-semibold text-foreground">
                Control center
              </h1>
              <p className="max-w-xl text-sm text-muted-foreground">
                Manage and customize your experience
              </p>
            </div>
          </div>
          <div
            className="flex items-center gap-2"
            data-tauri-drag-region="false"
          >
            <Button
              variant="outline"
              onClick={onClose}
              className="normal-case tracking-normal"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </Button>
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="flex flex-col gap-6">
            <Card
              className="border-border/60 bg-background/85 shadow-[0_20px_60px_rgba(15,23,42,0.08)] backdrop-blur animate-in fade-in slide-in-from-bottom-4"
              style={{ animationDuration: "720ms" }}
            >
              <CardHeader className="border-b border-border/60 pb-5">
                <CardTitle className="text-xl">Repositories</CardTitle>
                <CardDescription>
                  Set where new clones are saved by default.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 pt-6">
                {repoDirLoading ? (
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="space-y-2">
                      <Skeleton className="h-4 w-40" />
                      <Skeleton className="h-3 w-64" />
                    </div>
                    <Skeleton className="h-9 w-36" />
                  </div>
                ) : (
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="text-sm">
                      <div className="font-semibold">Default clone folder</div>
                      <div className="text-xs font-mono text-muted-foreground break-all">
                        {defaultRepoDir || "Not set"}
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      onClick={handlePickRepoDir}
                      disabled={repoDirSaving}
                      className="normal-case tracking-normal"
                    >
                      {repoDirSaving ? "Saving..." : "Choose folder"}
                    </Button>
                  </div>
                )}

                {repoDirError && (
                  <Alert variant="destructive">
                    <AlertDescription>{repoDirError}</AlertDescription>
                  </Alert>
                )}
              </CardContent>
            </Card>

            <Card
              className="border-border/60 bg-background/85 shadow-[0_20px_60px_rgba(15,23,42,0.08)] backdrop-blur animate-in fade-in slide-in-from-bottom-4"
              style={{ animationDuration: "760ms" }}
            >
              <CardHeader className="border-b border-border/60 pb-5">
                <CardTitle className="text-xl">Backend</CardTitle>
                <CardDescription>
                  Choose where Falck runs setup and launch commands.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 pt-6">
                {backendLoading ? (
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="space-y-2">
                      <Skeleton className="h-4 w-40" />
                      <Skeleton className="h-3 w-64" />
                    </div>
                    <Skeleton className="h-9 w-40" />
                  </div>
                ) : (
                  <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="text-sm">
                        <div className="font-semibold">Execution environment</div>
                        <div className="text-xs text-muted-foreground">
                          Run Falck commands on your host or in a VM per
                          repository.
                        </div>
                      </div>
                      <Select
                        value={backendMode}
                        onValueChange={(value) =>
                          void handleBackendChange(value as BackendMode)
                        }
                        disabled={backendSelectDisabled}
                      >
                        <SelectTrigger className="w-full sm:w-56">
                          <SelectValue placeholder="Select backend" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="host">Host machine</SelectItem>
                          <SelectItem value="virtualized">
                            Virtualized backend
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {backendMode === "virtualized" &&
                      backendPrereq?.installed && (
                        <div className="text-xs text-muted-foreground">
                          Virtualized backend enabled via{" "}
                          <span className="font-semibold">
                            {backendPrereq.tool}
                          </span>
                          .
                        </div>
                      )}
                    {backendChecking && (
                      <div className="text-xs text-muted-foreground">
                        Checking virtualized backend prerequisites…
                      </div>
                    )}
                  </div>
                )}

                {showBackendInstallPrompt && (
                  <Alert variant="destructive">
                    <AlertDescription className="space-y-3">
                      <div>
                        {backendPrereq?.message ??
                          "Install the virtualization prerequisite to enable this backend."}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          onClick={() => void handleInstallBackend()}
                          disabled={backendInstalling}
                          className="normal-case tracking-normal"
                        >
                          {backendInstalling
                            ? "Installing…"
                            : `Install ${backendPrereq?.tool ?? "tool"}`}
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => setPendingVirtualized(false)}
                          className="normal-case tracking-normal"
                        >
                          Not now
                        </Button>
                      </div>
                    </AlertDescription>
                  </Alert>
                )}

                {backendInstallMessage && (
                  <Alert>
                    <AlertDescription>{backendInstallMessage}</AlertDescription>
                  </Alert>
                )}

                {backendMode === "virtualized" && repoPath && (
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Button
                      variant="outline"
                      onClick={() => void handleResetBackend()}
                      disabled={backendResetting}
                      className="normal-case tracking-normal"
                    >
                      {backendResetting ? "Resetting…" : "Reset VM"}
                    </Button>
                    <span>Deletes the VM for this repo.</span>
                  </div>
                )}

                {backendResetMessage && (
                  <Alert>
                    <AlertDescription>{backendResetMessage}</AlertDescription>
                  </Alert>
                )}

                {backendError && (
                  <Alert variant="destructive">
                    <AlertDescription>{backendError}</AlertDescription>
                  </Alert>
                )}
              </CardContent>
            </Card>

            <Card
              className="border-border/60 bg-background/85 shadow-[0_20px_60px_rgba(15,23,42,0.08)] backdrop-blur animate-in fade-in slide-in-from-bottom-4"
              style={{ animationDuration: "800ms" }}
            >
              <CardHeader className="border-b border-border/60 pb-5">
                <CardTitle className="text-xl">Virtual machines</CardTitle>
                <CardDescription>
                  Review VM status, linked repositories, and lifecycle actions.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 pt-6">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-sm">
                    <div className="font-semibold">Managed backends</div>
                    <div className="text-xs text-muted-foreground">
                      Keep an eye on running VMs and clean up unused ones.
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    onClick={() => void loadVms(true)}
                    disabled={vmLoading || vmRefreshing}
                    className="normal-case tracking-normal"
                  >
                    {vmRefreshing ? "Refreshing..." : "Refresh list"}
                  </Button>
                </div>

                {vmLoading ? (
                  <div className="space-y-3">
                    <Skeleton className="h-16 w-full" />
                    <Skeleton className="h-16 w-full" />
                  </div>
                ) : vmList.length === 0 ? (
                  <div className="text-xs text-muted-foreground">
                    No virtual machines found.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {vmList.map((vm) => {
                      const status = vm.status || "unknown";
                      const statusLabel =
                        status.charAt(0).toUpperCase() + status.slice(1);
                      const statusVariant: "secondary" | "outline" | "destructive" =
                        status === "running"
                          ? "secondary"
                          : status === "stopped"
                            ? "outline"
                            : "destructive";
                      const isActiveRepo =
                        Boolean(repoPath) &&
                        Boolean(vm.repo_path) &&
                        repoPath === vm.repo_path;
                      const action = vmAction[vm.name];
                      const isStopping = action === "stopping";
                      const isDeleting = action === "deleting";
                      const stopDisabled = status === "stopped" || isStopping || isDeleting;
                      return (
                        <div
                          key={vm.name}
                          className="rounded-xl border border-border/60 bg-background/70 px-4 py-3 space-y-2"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="space-y-1">
                              <div className="text-sm font-semibold text-foreground">
                                {vm.name}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {vm.provider.toUpperCase()}
                                {isActiveRepo ? " • Active repo" : ""}
                              </div>
                            </div>
                            <Badge variant={statusVariant}>{statusLabel}</Badge>
                          </div>
                          {vm.repo_path ? (
                            <div className="text-xs font-mono text-muted-foreground break-all">
                              {vm.repo_path}
                            </div>
                          ) : (
                            <div className="text-xs text-muted-foreground">
                              Repo mapping unavailable.
                            </div>
                          )}
                          <div className="flex flex-wrap gap-2">
                            {vm.repo_path && onOpenRepo && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => onOpenRepo(vm.repo_path!)}
                                className="normal-case tracking-normal"
                              >
                                Open repo
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void handleStopVm(vm)}
                              disabled={stopDisabled}
                              className="normal-case tracking-normal"
                            >
                              {isStopping ? "Stopping…" : "Stop"}
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={() => void handleDeleteVm(vm)}
                              disabled={isDeleting}
                              className="normal-case tracking-normal"
                            >
                              {isDeleting ? "Deleting…" : "Delete"}
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {vmError && (
                  <Alert variant="destructive">
                    <AlertDescription>{vmError}</AlertDescription>
                  </Alert>
                )}
              </CardContent>
            </Card>

            <Card
              className="border-border/60 bg-background/85 shadow-[0_20px_60px_rgba(15,23,42,0.08)] backdrop-blur animate-in fade-in slide-in-from-bottom-4"
              style={{ animationDuration: "860ms" }}
            >
              <CardHeader className="border-b border-border/60 pb-5">
                <CardTitle className="text-xl">GitHub integration</CardTitle>
                <CardDescription>
                  Connect once to upload SSH keys and list repositories.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 pt-6">
                {githubChecking ? (
                  <div className="space-y-3">
                    <Skeleton className="h-4 w-48" />
                    <Skeleton className="h-3 w-64" />
                    <Skeleton className="h-9 w-32" />
                  </div>
                ) : githubConnected ? (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="text-sm text-muted-foreground">
                      Connected as{" "}
                      <span className="font-semibold text-foreground">
                        {githubUser?.login ?? "GitHub user"}
                      </span>
                    </div>
                    <Button
                      variant="outline"
                      onClick={() => void handleGithubDisconnect()}
                      disabled={githubWorking}
                      className="normal-case tracking-normal"
                    >
                      Disconnect
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="text-sm text-muted-foreground">
                      Sign in to let Falck add SSH keys and list your
                      repositories.
                    </div>
                    {githubDevice && (
                      <Alert>
                        <AlertDescription>
                          Visit{" "}
                          <span className="font-semibold">
                            {githubDevice.verification_uri}
                          </span>{" "}
                          and enter code{" "}
                          <span className="font-mono font-semibold">
                            {githubDevice.user_code}
                          </span>
                          .
                        </AlertDescription>
                      </Alert>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        onClick={() => void handleGithubConnect()}
                        disabled={githubWorking || githubChecking}
                        className="normal-case tracking-normal"
                      >
                        {githubWorking ? "Connecting…" : "Connect GitHub"}
                      </Button>
                      {githubDevice && (
                        <Button
                          variant="outline"
                          onClick={() =>
                            void falckService.openInBrowser(
                              githubDevice.verification_uri_complete ??
                                githubDevice.verification_uri,
                            )
                          }
                          className="normal-case tracking-normal"
                        >
                          Open GitHub
                        </Button>
                      )}
                    </div>
                  </div>
                )}

                {githubError && (
                  <Alert variant="destructive">
                    <AlertDescription>{githubError}</AlertDescription>
                  </Alert>
                )}
              </CardContent>
            </Card>

            <Card
              className="border-border/60 bg-background/85 shadow-[0_20px_60px_rgba(15,23,42,0.08)] backdrop-blur animate-in fade-in slide-in-from-bottom-4"
              style={{ animationDuration: "880ms" }}
            >
              <CardHeader className="border-b border-border/60 pb-5">
                <CardTitle className="text-xl">SSH key</CardTitle>
                <CardDescription>Used for all Git operations.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 pt-6 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-sm">
                  <div className="font-semibold">{sshKey.name}</div>
                  <div className="text-xs font-mono text-muted-foreground">
                    {sshKey.fingerprint}
                  </div>
                </div>
                <Button
                  variant="outline"
                  onClick={onManageSSHKey}
                  className="normal-case tracking-normal"
                >
                  Manage SSH key
                </Button>
              </CardContent>
            </Card>
          </div>

          <div className="flex flex-col gap-6">
            {openCodeReady ? (
              <>
                <OpenCodeInstallPanel className="border-border/60 bg-background/85 shadow-[0_20px_60px_rgba(15,23,42,0.08)] backdrop-blur animate-in fade-in slide-in-from-bottom-4" />
                <OpenCodeSettingsPanel className="border-border/60 bg-background/85 shadow-[0_20px_60px_rgba(15,23,42,0.08)] backdrop-blur animate-in fade-in slide-in-from-bottom-4" />
              </>
            ) : (
              <>
                <Card className="border-border/60 bg-background/85 shadow-[0_20px_60px_rgba(15,23,42,0.08)] backdrop-blur">
                  <CardHeader className="border-b border-border/60 pb-5">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-3 w-56" />
                  </CardHeader>
                  <CardContent className="space-y-4 pt-6">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-full" />
                    <Skeleton className="h-9 w-36" />
                  </CardContent>
                </Card>
                <Card className="border-border/60 bg-background/85 shadow-[0_20px_60px_rgba(15,23,42,0.08)] backdrop-blur">
                  <CardHeader className="border-b border-border/60 pb-5">
                    <Skeleton className="h-4 w-44" />
                    <Skeleton className="h-3 w-52" />
                  </CardHeader>
                  <CardContent className="space-y-3 pt-6">
                    <Skeleton className="h-9 w-full" />
                    <Skeleton className="h-9 w-full" />
                    <Skeleton className="h-9 w-40" />
                  </CardContent>
                </Card>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
