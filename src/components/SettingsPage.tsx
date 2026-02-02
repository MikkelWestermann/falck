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
import { falckService } from "@/services/falckService";
import {
  GithubDeviceResponse,
  GithubUser,
  githubService,
} from "@/services/githubService";
import { settingsService } from "@/services/settingsService";
import { SSHKey } from "@/services/sshService";

interface SettingsPageProps {
  sshKey: SSHKey;
  onManageSSHKey: () => void;
  onClose: () => void;
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
    <div className="relative min-h-screen bg-background text-foreground">
      <header className="relative z-10 border-b-2 border-border/80 bg-card/80 backdrop-blur">
        <div className="mx-auto w-full max-w-5xl px-6 py-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.4em] text-muted-foreground">
                Settings
              </p>
              <p className="text-sm text-muted-foreground">
                Manage GitHub, SSH keys, and AI providers.
              </p>
            </div>
            <div data-tauri-drag-region="false">
              <Button variant="outline" onClick={onClose}>
                Back
              </Button>
            </div>
          </div>
        </div>
      </header>

      <main className="relative z-10 mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-8">
        <Card>
          <CardHeader>
            <CardTitle>Repositories</CardTitle>
            <CardDescription>Set where new clones are saved.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-sm">
                <div className="font-semibold">Default clone folder</div>
                <div className="text-xs font-mono text-muted-foreground">
                  {repoDirLoading ? "Loading..." : defaultRepoDir || "Not set"}
                </div>
              </div>
              <Button
                variant="outline"
                onClick={handlePickRepoDir}
                disabled={repoDirLoading || repoDirSaving}
              >
                {repoDirSaving ? "Saving..." : "Choose folder"}
              </Button>
            </div>

            {repoDirError && (
              <Alert variant="destructive">
                <AlertDescription>{repoDirError}</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>GitHub integration</CardTitle>
            <CardDescription>
              Connect once to upload SSH keys and list repositories.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {githubConnected ? (
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
                >
                  Disconnect
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="text-sm text-muted-foreground">
                  Sign in to let Falck add SSH keys and list your repositories.
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

        <Card>
          <CardHeader>
            <CardTitle>SSH key</CardTitle>
            <CardDescription>Used for all Git operations.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm">
              <div className="font-semibold">{sshKey.name}</div>
              <div className="text-xs font-mono text-muted-foreground">
                {sshKey.fingerprint}
              </div>
            </div>
            <Button variant="outline" onClick={onManageSSHKey}>
              Manage SSH key
            </Button>
          </CardContent>
        </Card>

        <OpenCodeInstallPanel />
        <OpenCodeSettingsPanel />
      </main>
    </div>
  );
}
