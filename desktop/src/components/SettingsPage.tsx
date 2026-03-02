import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";

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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { OpenCodeInstallPanel } from "@/components/OpenCodeManager";
import { OpenCodeSettingsPanel } from "@/components/OpenCodeSettings";
import { LimaContainersPanel } from "@/components/LimaContainersPanel";
import { VirtualizedBackendPanel } from "@/components/VirtualizedBackendPanel";
import { configService } from "@/services/configService";
import { falckService } from "@/services/falckService";
import {
  GithubDeviceResponse,
  githubService,
} from "@/services/githubService";
import { settingsService } from "@/services/settingsService";
import { SSHKey } from "@/services/sshService";
import { cn } from "@/lib/utils";
import { ArrowLeft } from "lucide-react";
import { useAppState } from "@/router/app-state";
import { githubKeys, settingsKeys } from "@/queries/keys";
import { useGithubHasToken, useGithubUser } from "@/queries/github";
import { useDefaultRepoDir } from "@/queries/settings";
import { runUpdateFlow, type UpdateState } from "@/lib/updates";

interface SettingsPageProps {
  sshKey: SSHKey;
  onManageSSHKey: () => void;
  onClose: () => void;
}

function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn("animate-pulse rounded-lg bg-muted/60", className)} />
  );
}

export function SettingsPage({
  sshKey,
  onManageSSHKey,
  onClose,
}: SettingsPageProps) {
  const { setRepoPath, setSshKey } = useAppState();
  const queryClient = useQueryClient();
  const [repoDirError, setRepoDirError] = useState<string | null>(null);
  const [githubDevice, setGithubDevice] = useState<GithubDeviceResponse | null>(
    null,
  );
  const [githubError, setGithubError] = useState<string | null>(null);
  const [openCodeReady, setOpenCodeReady] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetConfirm, setResetConfirm] = useState("");
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [updateState, setUpdateState] = useState<UpdateState>({
    phase: "idle",
  });

  const defaultRepoDirQuery = useDefaultRepoDir();
  const defaultRepoDir = defaultRepoDirQuery.data ?? null;
  const repoDirLoading = defaultRepoDirQuery.isLoading;
  const repoDirLoadError = defaultRepoDirQuery.error
    ? `Failed to load default folder: ${String(defaultRepoDirQuery.error)}`
    : null;

  const githubTokenQuery = useGithubHasToken();
  const hasGithubToken = Boolean(githubTokenQuery.data);
  const githubUserQuery = useGithubUser(hasGithubToken);
  const githubUser = githubUserQuery.data ?? null;
  const tokenError = githubUserQuery.error;
  const tokenInvalid = tokenError
    ? String(tokenError).toLowerCase().includes("token")
    : false;
  const githubConnected = hasGithubToken && !tokenInvalid;
  const githubChecking = githubTokenQuery.isLoading;
  const githubQueryError = githubTokenQuery.error
    ? `GitHub auth unavailable: ${String(githubTokenQuery.error)}`
    : githubUserQuery.error
      ? String(githubUserQuery.error)
      : null;
  const githubErrorMessage = githubError ?? githubQueryError;

  useEffect(() => {
    if (!isTauri()) {
      setAppVersion(null);
      return;
    }

    let active = true;

    void (async () => {
      try {
        const version = await getVersion();
        if (active) {
          setAppVersion(version);
        }
      } catch (error) {
        console.warn("Failed to load app version:", error);
      }
    })();

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

  const connectMutation = useMutation({
    mutationFn: async () => {
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
    },
    onSuccess: async () => {
      setGithubDevice(null);
      setGithubError(null);
      await queryClient.invalidateQueries({ queryKey: githubKeys.all });
    },
    onError: (err) => {
      setGithubDevice(null);
      setGithubError(`GitHub login failed: ${String(err)}`);
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      await githubService.clearToken();
    },
    onSuccess: async () => {
      setGithubDevice(null);
      await queryClient.invalidateQueries({ queryKey: githubKeys.all });
    },
    onError: (err) => {
      setGithubError(`Failed to disconnect: ${String(err)}`);
    },
  });

  const updateRepoDirMutation = useMutation({
    mutationFn: async (path: string) => {
      await settingsService.setDefaultRepoDir(path);
      return path;
    },
    onSuccess: (path) => {
      queryClient.setQueryData(settingsKeys.defaultRepoDir(), path);
    },
  });

  const githubWorking =
    connectMutation.isPending || disconnectMutation.isPending;
  const repoDirSaving = updateRepoDirMutation.isPending;
  const repoDirErrorMessage = repoDirError ?? repoDirLoadError;
  const updateBusy = ["checking", "downloading", "installing"].includes(
    updateState.phase,
  );

  const updateBadge = (() => {
    switch (updateState.phase) {
      case "checking":
      case "downloading":
      case "installing":
        return { label: "Checking…", variant: "secondary" as const };
      case "available":
        return { label: "Update available", variant: "default" as const };
      case "installed":
        return { label: "Update ready", variant: "default" as const };
      case "up-to-date":
        return { label: "Up to date", variant: "secondary" as const };
      case "error":
        return { label: "Update failed", variant: "destructive" as const };
      case "unsupported":
        return { label: "Unavailable", variant: "outline" as const };
      default:
        return { label: "Not checked", variant: "outline" as const };
    }
  })();

  const updateVersionLabel = updateState.version
    ? ` ${updateState.version}`
    : "";

  const updateStatus = (() => {
    switch (updateState.phase) {
      case "checking":
        return "Checking for updates…";
      case "available":
        return `Update${updateVersionLabel} is available.`;
      case "downloading":
        return `Downloading update${updateVersionLabel}…`;
      case "installing":
        return `Installing update${updateVersionLabel}…`;
      case "installed":
        return `Update${updateVersionLabel} installed. Restart Falck to apply it.`;
      case "up-to-date":
        return "You are already on the latest version.";
      case "error":
        return updateState.message
          ? `Update check failed: ${updateState.message}`
          : "Update check failed.";
      case "unsupported":
        return updateState.message ?? "Updates are only available in the desktop app.";
      default:
        return "Check for updates to see if anything new is available.";
    }
  })();

  const updateButtonLabel = updateBusy
    ? updateState.phase === "downloading"
      ? "Downloading…"
      : updateState.phase === "installing"
        ? "Installing…"
        : "Checking…"
    : updateState.phase === "available"
      ? "Install update"
      : "Check for updates";

  const handleGithubConnect = async () => {
    setGithubError(null);
    connectMutation.mutate();
  };

  const handleGithubDisconnect = () => {
    setGithubError(null);
    disconnectMutation.mutate();
  };

  const handlePickRepoDir = async () => {
    setRepoDirError(null);
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
      await updateRepoDirMutation.mutateAsync(selectedPath);
    } catch (err) {
      setRepoDirError(`Failed to update folder: ${String(err)}`);
    }
  };

  const resetReady = resetConfirm.trim().toLowerCase() === "reset";

  const handleResetOpenChange = (open: boolean) => {
    setResetOpen(open);
    if (!open) {
      setResetConfirm("");
      setResetError(null);
      setResetting(false);
    }
  };

  const handleResetApp = async () => {
    setResetError(null);
    setResetting(true);
    try {
      await falckService.resetApp();
      setRepoPath(null);
      setSshKey(null);
      window.localStorage.clear();
      configService.setSelectedSSHKey(null);
      configService.setSetupCompleted(false);
      window.location.assign("/");
    } catch (err) {
      setResetError(`Reset failed: ${String(err)}`);
      setResetting(false);
    }
  };

  const handleCheckForUpdates = async () => {
    const finalState = await runUpdateFlow({
      userInitiated: true,
      onState: (state) => setUpdateState(state),
    });
    setUpdateState(finalState);
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
              style={{ animationDuration: "640ms" }}
            >
              <CardHeader className="border-b border-border/60 pb-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <CardTitle className="text-xl">Updates</CardTitle>
                    <CardDescription>
                      Keep Falck up to date with the latest fixes.
                    </CardDescription>
                  </div>
                  <Badge variant={updateBadge.variant}>{updateBadge.label}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4 pt-6">
                <div className="space-y-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold">Current version</span>
                    <span className="text-xs font-mono text-muted-foreground">
                      {appVersion ?? "Unknown"}
                    </span>
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {updateStatus}
                  </div>
                </div>

                {updateState.phase === "downloading" &&
                  updateState.progress?.percent !== undefined && (
                    <div className="space-y-2">
                      <Progress value={updateState.progress.percent} />
                      <div className="text-xs text-muted-foreground">
                        {updateState.progress.percent}% downloaded
                      </div>
                    </div>
                  )}

                {updateState.notes && (
                  <div className="rounded-lg border border-border/60 bg-muted/40 p-3 text-sm text-muted-foreground">
                    <div className="text-xs font-semibold uppercase tracking-wide">
                      What's new
                    </div>
                    <p className="mt-2 whitespace-pre-wrap text-foreground/90">
                      {updateState.notes}
                    </p>
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    onClick={() => void handleCheckForUpdates()}
                    disabled={updateBusy}
                    className="normal-case tracking-normal"
                  >
                    {updateButtonLabel}
                  </Button>
                </div>
              </CardContent>
            </Card>
            <VirtualizedBackendPanel className="border-border/60 bg-background/85 shadow-[0_20px_60px_rgba(15,23,42,0.08)] backdrop-blur animate-in fade-in slide-in-from-bottom-4" />
            <LimaContainersPanel className="border-border/60 bg-background/85 shadow-[0_20px_60px_rgba(15,23,42,0.08)] backdrop-blur animate-in fade-in slide-in-from-bottom-4" />
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

                {repoDirErrorMessage && (
                  <Alert variant="destructive">
                    <AlertDescription>{repoDirErrorMessage}</AlertDescription>
                  </Alert>
                )}
              </CardContent>
            </Card>

            <Card
              className="border-border/60 bg-background/85 shadow-[0_20px_60px_rgba(15,23,42,0.08)] backdrop-blur animate-in fade-in slide-in-from-bottom-4"
              style={{ animationDuration: "800ms" }}
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

                {githubErrorMessage && (
                  <Alert variant="destructive">
                    <AlertDescription>{githubErrorMessage}</AlertDescription>
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

            <Card className="border-destructive/40 bg-destructive/5 shadow-[0_20px_60px_rgba(127,29,29,0.18)] backdrop-blur animate-in fade-in slide-in-from-bottom-4">
              <CardHeader className="border-b border-destructive/30 pb-5">
                <CardTitle className="text-xl text-destructive">
                  Danger zone
                </CardTitle>
                <CardDescription>
                  Reset Falck and start fresh from the setup wizard.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 pt-6">
                <div className="space-y-2 text-sm text-muted-foreground">
                  <p>
                    This wipes local app data, removes managed VMs and containers,
                    and signs you out of GitHub.
                  </p>
                  <p>
                    Your repositories and SSH keys stay on disk. You can onboard
                    again from scratch.
                  </p>
                </div>
                <Button
                  variant="destructive"
                  onClick={() => setResetOpen(true)}
                  className="normal-case tracking-normal"
                >
                  Reset app
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

      <Dialog open={resetOpen} onOpenChange={handleResetOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Reset Falck</DialogTitle>
            <DialogDescription>
              This deletes local app data, VMs, and containers. You will be
              returned to the setup wizard.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
              This action cannot be undone.
            </div>
            <div className="space-y-2">
              <Label htmlFor="reset-confirm">Type RESET to confirm</Label>
              <Input
                id="reset-confirm"
                value={resetConfirm}
                onChange={(event) => setResetConfirm(event.target.value)}
                placeholder="RESET"
                disabled={resetting}
              />
            </div>
            {resetError && (
              <Alert variant="destructive">
                <AlertDescription>{resetError}</AlertDescription>
              </Alert>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => handleResetOpenChange(false)}
                disabled={resetting}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => void handleResetApp()}
                disabled={!resetReady || resetting}
              >
                {resetting ? "Resetting..." : "Reset app"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
