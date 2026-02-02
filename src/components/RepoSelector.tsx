import { useEffect, useMemo, useState } from "react";
import { useForm } from "@tanstack/react-form";
import { join } from "@tauri-apps/api/path";

import { FormField } from "@/components/form/FormField";
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
import { Input } from "@/components/ui/input";
import { cloneRepoSchema, openRepoSchema } from "@/schemas/forms";
import { gitService } from "@/services/gitService";
import { falckService } from "@/services/falckService";
import {
  GithubDeviceResponse,
  GithubRepo,
  GithubUser,
  githubService,
} from "@/services/githubService";
import { settingsService } from "@/services/settingsService";
import { Settings } from "lucide-react";
import { ThemeButton } from "@/components/ThemeButton";

interface RepoSelectorProps {
  onRepoSelect: (path: string) => void;
  onOpenSettings?: () => void;
}

export function RepoSelector({
  onRepoSelect,
  onOpenSettings,
}: RepoSelectorProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedRepos, setSavedRepos] = useState<
    Awaited<ReturnType<typeof gitService.listSavedRepos>>
  >([]);
  const [defaultRepoDir, setDefaultRepoDir] = useState<string | null>(null);
  const [defaultRepoDirLoading, setDefaultRepoDirLoading] = useState(true);
  const [githubConnected, setGithubConnected] = useState(false);
  const [githubChecking, setGithubChecking] = useState(true);
  const [githubAuthBusy, setGithubAuthBusy] = useState(false);
  const [githubDevice, setGithubDevice] = useState<GithubDeviceResponse | null>(
    null,
  );
  const [githubUser, setGithubUser] = useState<GithubUser | null>(null);
  const [githubRepos, setGithubRepos] = useState<GithubRepo[]>([]);
  const [githubLoading, setGithubLoading] = useState(false);
  const [githubError, setGithubError] = useState<string | null>(null);
  const [githubQuery, setGithubQuery] = useState("");

  useEffect(() => {
    void loadSavedRepos();
    void loadDefaultRepoDir();
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
    if (!githubConnected || githubChecking || githubLoading) {
      return;
    }
    if (githubRepos.length === 0) {
      void loadGithubRepos();
    }
  }, [githubConnected, githubChecking, githubLoading, githubRepos.length]);

  const loadSavedRepos = async () => {
    try {
      const repos = await gitService.listSavedRepos();
      setSavedRepos(repos);
    } catch (err) {
      console.error("Failed to load saved repos:", err);
    }
  };

  const loadDefaultRepoDir = async () => {
    try {
      const dir = await settingsService.getDefaultRepoDir();
      setDefaultRepoDir(dir);
    } catch (err) {
      console.error("Failed to load default repo dir:", err);
    } finally {
      setDefaultRepoDirLoading(false);
    }
  };

  const loadGithubRepos = async () => {
    setGithubLoading(true);
    setGithubError(null);
    try {
      const repos = await githubService.listRepos();
      setGithubRepos(repos);
    } catch (err) {
      const message = String(err);
      setGithubError(message);
      if (message.toLowerCase().includes("token")) {
        setGithubConnected(false);
      }
    } finally {
      setGithubLoading(false);
    }
  };

  const handleGithubLogin = async () => {
    setGithubError(null);
    setGithubAuthBusy(true);
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
      await loadGithubRepos();
    } catch (err) {
      setGithubConnected(false);
      setGithubDevice(null);
      setGithubError(`GitHub login failed: ${String(err)}`);
    } finally {
      setGithubAuthBusy(false);
    }
  };

  const normalizeRepoFolder = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) {
      return "repo";
    }
    return trimmed.replace(/[\\/]+/g, "-");
  };

  const cloneForm = useForm({
    defaultValues: {
      name: "",
      url: "",
    },
    validators: {
      onSubmit: cloneRepoSchema,
    },
    onSubmit: async ({ value }) => {
      setLoading(true);
      setError(null);
      try {
        if (!defaultRepoDir) {
          throw new Error("Set a default clone folder in settings first.");
    }
    const folderName = normalizeRepoFolder(value.name);
    const localPath = await join(defaultRepoDir, folderName);
    await gitService.cloneRepository(value.url, localPath);
        await gitService.saveRepo(value.name, localPath);
        onRepoSelect(localPath);
        cloneForm.reset();
        await loadSavedRepos();
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    },
  });

  const clonePathPreview = useMemo(() => {
    if (!defaultRepoDir) {
      return "";
    }
    const folder = normalizeRepoFolder(cloneForm.state.values.name ?? "");
    const separator = defaultRepoDir.includes("\\") ? "\\" : "/";
    const base = defaultRepoDir.replace(/[\\/]+$/, "");
    const suffix = folder.replace(/^[\\/]+/, "");
    return suffix ? `${base}${separator}${suffix}` : base;
  }, [defaultRepoDir, cloneForm.state.values.name]);

  const openForm = useForm({
    defaultValues: {
      name: "",
      path: "",
    },
    validators: {
      onSubmit: openRepoSchema,
    },
    onSubmit: async ({ value }) => {
      setLoading(true);
      setError(null);
      try {
        await gitService.getRepositoryInfo(value.path);
        await gitService.saveRepo(value.name, value.path);
        onRepoSelect(value.path);
        openForm.reset();
        await loadSavedRepos();
      } catch (err) {
        setError("That folder does not look like a Git repository.");
      } finally {
        setLoading(false);
      }
    },
  });

  const handleOpenSaved = async (path: string, name: string) => {
    setLoading(true);
    setError(null);
    try {
      await gitService.saveRepo(name, path);
      onRepoSelect(path);
    } catch (err) {
      setError("That repository is no longer available.");
      await loadSavedRepos();
    } finally {
      setLoading(false);
    }
  };

  const handleCloneGithubRepo = async (repo: GithubRepo) => {
    setLoading(true);
    setError(null);
    try {
      if (!defaultRepoDir) {
        throw new Error("Set a default clone folder in settings first.");
      }
      const folderName = normalizeRepoFolder(repo.name);
      const localPath = await join(defaultRepoDir, folderName);
      await gitService.cloneRepository(repo.ssh_url, localPath);
      await gitService.saveRepo(repo.full_name, localPath);
      onRepoSelect(localPath);
      await loadSavedRepos();
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const filteredGithubRepos = useMemo(() => {
    const query = githubQuery.trim().toLowerCase();
    if (!query) {
      return githubRepos;
    }
    return githubRepos.filter((repo) => {
      const fullName = repo.full_name.toLowerCase();
      const owner = repo.owner?.login?.toLowerCase() ?? "";
      return fullName.includes(query) || owner.includes(query);
    });
  }, [githubRepos, githubQuery]);

  return (
    <div className="min-h-screen">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-10">
        <div className="flex justify-end gap-2">
          <ThemeButton />
          <Button variant="outline" size="sm" onClick={onOpenSettings}>
            <Settings className="h-4 w-4" />
            <span>Settings</span>
          </Button>
        </div>

        {savedRepos.length > 0 && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle>Recent repositories</CardTitle>
                <CardDescription>Pick up where you left off.</CardDescription>
              </div>
              <Button variant="outline" size="sm" onClick={loadSavedRepos}>
                Refresh
              </Button>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3">
                {savedRepos.map((repo) => (
                  <button
                    key={repo.path}
                    className="group flex w-full items-center justify-between gap-4 rounded-lg border-2 border-border bg-card/70 px-4 py-3 text-left shadow-[var(--shadow-xs)] transition hover:bg-secondary/20 active:shadow-none"
                    onClick={() => handleOpenSaved(repo.path, repo.name)}
                    disabled={loading}
                  >
                    <div>
                      <div className="text-sm font-semibold text-foreground">
                        {repo.name}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {repo.path}
                      </div>
                    </div>
                    <Badge variant="outline">Open</Badge>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Clone from GitHub</CardTitle>
            <CardDescription>
              Connect once to browse and clone repositories with SSH.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {githubConnected ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-sm text-muted-foreground">
                    Connected as{" "}
                    <span className="font-semibold text-foreground">
                      {githubUser?.login ?? "GitHub user"}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void loadGithubRepos()}
                      disabled={githubLoading}
                    >
                      {githubLoading ? "Loading…" : "Refresh"}
                    </Button>
                    {onOpenSettings && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={onOpenSettings}
                      >
                        Manage integration
                      </Button>
                    )}
                  </div>
                </div>

                <Input
                  value={githubQuery}
                  onChange={(event) => setGithubQuery(event.target.value)}
                  placeholder="Filter repositories"
                />

                {githubLoading ? (
                  <div className="rounded-lg border-2 border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
                    Loading repositories…
                  </div>
                ) : filteredGithubRepos.length === 0 ? (
                  <div className="rounded-lg border-2 border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
                    No repositories loaded yet.
                  </div>
                ) : (
                  <div className="grid gap-3">
                    {filteredGithubRepos.map((repo) => (
                      <div
                        key={repo.id}
                        className="flex flex-col gap-3 rounded-lg border-2 border-border bg-card/70 px-4 py-3 shadow-[var(--shadow-xs)]"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <div className="text-sm font-semibold">
                              {repo.full_name}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {repo.ssh_url}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {repo.private && (
                              <Badge variant="secondary">Private</Badge>
                            )}
                            {repo.fork && <Badge variant="outline">Fork</Badge>}
                          </div>
                        </div>
                        <Button
                          onClick={() => void handleCloneGithubRepo(repo)}
                          disabled={loading || defaultRepoDirLoading}
                        >
                          {loading ? "Cloning…" : "Clone"}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="space-y-4">
                <div className="text-sm text-muted-foreground">
                  Sign in once and Falck will remember your GitHub access token
                  securely.
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
                    onClick={() => void handleGithubLogin()}
                    disabled={githubAuthBusy || githubChecking}
                  >
                    {githubAuthBusy ? "Connecting…" : "Connect GitHub"}
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

        <details className="rounded-lg border-2 border-border bg-card p-4">
          <summary className="cursor-pointer font-semibold">
            Or do it manually
          </summary>
          <div className="mt-4 grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Clone repository</CardTitle>
                <CardDescription>
                  Start from an SSH URL and clone into your default folder.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void cloneForm.handleSubmit();
                  }}
                  className="space-y-4"
                >
                  <cloneForm.Field name="name">
                    {(field) => (
                      <FormField
                        field={field}
                        label="Repo name"
                        placeholder="Marketing site"
                        required
                      />
                    )}
                  </cloneForm.Field>
                  <cloneForm.Field name="url">
                    {(field) => (
                      <FormField
                        field={field}
                        label="Repository URL"
                        placeholder="git@github.com:org/repo.git"
                        helpText="SSH URLs are required for authenticated Git operations."
                        required
                      />
                    )}
                  </cloneForm.Field>
                  <div className="space-y-2 text-sm">
                    <div className="font-medium">Clone destination</div>
                    <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs font-mono text-muted-foreground">
                      {defaultRepoDirLoading
                        ? "Loading..."
                        : clonePathPreview ||
                          "Set a default clone folder in settings."}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Change the default folder in Settings.
                    </p>
                  </div>
                  <Button
                    type="submit"
                    disabled={loading || defaultRepoDirLoading || !defaultRepoDir}
                    className="w-full"
                  >
                    {loading ? "Cloning…" : "Clone"}
                  </Button>
                </form>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Open existing</CardTitle>
                <CardDescription>
                  Point Falck at a folder already on your disk.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void openForm.handleSubmit();
                  }}
                  className="space-y-4"
                >
                  <openForm.Field name="name">
                    {(field) => (
                      <FormField
                        field={field}
                        label="Repo name"
                        placeholder="Internal tools"
                        required
                      />
                    )}
                  </openForm.Field>
                  <openForm.Field name="path">
                    {(field) => (
                      <FormField
                        field={field}
                        label="Repository path"
                        placeholder="/Users/you/dev/project"
                        required
                      />
                    )}
                  </openForm.Field>
                  <Button
                    type="submit"
                    variant="outline"
                    disabled={loading}
                    className="w-full"
                  >
                    {loading ? "Opening…" : "Open repo"}
                  </Button>
                </form>
              </CardContent>
            </Card>
          </div>
        </details>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>
    </div>
  );
}
