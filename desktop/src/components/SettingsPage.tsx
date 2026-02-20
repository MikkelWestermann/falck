import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { OpenCodeInstallPanel } from "@/components/OpenCodeManager";
import { OpenCodeSettingsPanel } from "@/components/OpenCodeSettings";
import { LimaContainersPanel } from "@/components/LimaContainersPanel";
import { VirtualizedBackendPanel } from "@/components/VirtualizedBackendPanel";
import { falckService } from "@/services/falckService";
import {
  GithubDeviceResponse,
  GithubUser,
  githubService,
} from "@/services/githubService";
import { settingsService } from "@/services/settingsService";
import { SSHKey } from "@/services/sshService";
import { cn } from "@/lib/utils";
import { ArrowLeft } from "lucide-react";

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
            <VirtualizedBackendPanel className="border-border/60 bg-background/85 shadow-[0_20px_60px_rgba(15,23,42,0.08)] backdrop-blur animate-in fade-in slide-in-from-bottom-4" />
            <LimaContainersPanel className="border-border/60 bg-background/85 shadow-[0_20px_60px_rgba(15,23,42,0.08)] backdrop-blur animate-in fade-in slide-in-from-bottom-4" />
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
