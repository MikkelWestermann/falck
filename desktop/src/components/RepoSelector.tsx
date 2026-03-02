import { useMemo, useState } from "react";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { gitKeys, githubKeys } from "@/queries/keys";
import { useSavedRepos } from "@/queries/git";
import { useGithubHasToken, useGithubRepos, useGithubUser } from "@/queries/github";
import { useDefaultRepoDir } from "@/queries/settings";
import { cloneRepoSchema, openRepoSchema } from "@/schemas/forms";
import { falckService } from "@/services/falckService";
import {
  GithubDeviceResponse,
  GithubRepo,
  githubService,
} from "@/services/githubService";
import { gitService, SavedRepo } from "@/services/gitService";
import { ThemeButton } from "@/components/ThemeButton";
import {
  ChevronDown,
  ChevronUp,
  Plus,
  Search,
  Settings,
  Trash2,
} from "lucide-react";

interface RepoSelectorProps {
  onRepoSelect: (path: string) => void;
  onOpenSettings?: () => void;
  onCreateProject?: () => void;
}

const SAVED_PREVIEW_COUNT = 6;
const GITHUB_PREVIEW_COUNT = 6;

type CloneRepoInput = {
  name: string;
  url: string;
  repoLabel: string;
  source: "form" | "github";
  repoId?: number;
};

export function RepoSelector({
  onRepoSelect,
  onOpenSettings,
  onCreateProject,
}: RepoSelectorProps) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [githubDevice, setGithubDevice] = useState<GithubDeviceResponse | null>(
    null,
  );
  const [githubError, setGithubError] = useState<string | null>(null);
  const [githubQuery, setGithubQuery] = useState("");
  const [savedQuery, setSavedQuery] = useState("");
  const [showAllSaved, setShowAllSaved] = useState(false);
  const [showAllGithub, setShowAllGithub] = useState(false);
  const [repoToRemove, setRepoToRemove] = useState<SavedRepo | null>(null);
  const [removingRepo, setRemovingRepo] = useState(false);

  const savedReposQuery = useSavedRepos();
  const savedRepos = savedReposQuery.data ?? [];
  const defaultRepoDirQuery = useDefaultRepoDir();
  const defaultRepoDir = defaultRepoDirQuery.data ?? null;
  const defaultRepoDirLoading = defaultRepoDirQuery.isLoading;

  const githubTokenQuery = useGithubHasToken();
  const hasGithubToken = Boolean(githubTokenQuery.data);
  const githubUserQuery = useGithubUser(hasGithubToken);
  const githubReposQuery = useGithubRepos(hasGithubToken);
  const githubUser = githubUserQuery.data ?? null;
  const githubRepos = githubReposQuery.data ?? [];
  const githubLoading = githubReposQuery.isFetching;

  const tokenError = githubUserQuery.error ?? githubReposQuery.error;
  const tokenInvalid = tokenError
    ? String(tokenError).toLowerCase().includes("token")
    : false;
  const githubConnected = hasGithubToken && !tokenInvalid;
  const githubChecking = githubTokenQuery.isLoading;

  const githubQueryError = githubReposQuery.error
    ? String(githubReposQuery.error)
    : githubUserQuery.error
      ? String(githubUserQuery.error)
      : githubTokenQuery.error
        ? `GitHub auth unavailable: ${String(githubTokenQuery.error)}`
        : null;
  const githubErrorMessage = githubError ?? githubQueryError;

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

  const cloneRepoMutation = useMutation({
    mutationFn: async (input: CloneRepoInput) => {
      if (!defaultRepoDir) {
        throw new Error("Set a default clone folder in settings first.");
      }
      const folderName = normalizeRepoFolder(input.name);
      const localPath = await join(defaultRepoDir, folderName);
      await gitService.cloneRepository(input.url, localPath);
      await gitService.saveRepo(input.repoLabel, localPath);
      return localPath;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: gitKeys.savedRepos() });
    },
  });

  const saveRepoMutation = useMutation({
    mutationFn: async (input: {
      name: string;
      path: string;
      validate?: boolean;
    }) => {
      if (input.validate) {
        await gitService.getRepositoryInfo(input.path);
      }
      await gitService.saveRepo(input.name, input.path);
      return input.path;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: gitKeys.savedRepos() });
    },
  });

  const removeRepoMutation = useMutation({
    mutationFn: async (path: string) => {
      await gitService.removeSavedRepo(path);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: gitKeys.savedRepos() });
    },
  });

  const cloning = cloneRepoMutation.isPending;
  const activeClone = cloning ? cloneRepoMutation.variables : null;
  const openingRepo = saveRepoMutation.isPending;
  const busy = cloning || openingRepo;
  const githubAuthBusy = connectMutation.isPending;

  const handleGithubLogin = () => {
    setGithubError(null);
    connectMutation.mutate();
  };

  const handleRefreshGithubRepos = () => {
    setGithubError(null);
    void githubReposQuery.refetch();
  };

  const handleRefreshSavedRepos = () => {
    void savedReposQuery.refetch();
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
      setError(null);
      try {
        const localPath = await cloneRepoMutation.mutateAsync({
          name: value.name,
          url: value.url,
          repoLabel: value.name,
          source: "form",
        });
        onRepoSelect(localPath);
        cloneForm.reset();
      } catch (err) {
        setError(String(err));
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
      setError(null);
      try {
        const localPath = await saveRepoMutation.mutateAsync({
          name: value.name,
          path: value.path,
          validate: true,
        });
        onRepoSelect(localPath);
        openForm.reset();
      } catch (err) {
        setError("That folder does not look like a Git repository.");
      }
    },
  });

  const handleOpenSaved = async (path: string, name: string) => {
    setError(null);
    try {
      const localPath = await saveRepoMutation.mutateAsync({
        name,
        path,
        validate: false,
      });
      onRepoSelect(localPath);
    } catch (err) {
      setError("That repository is no longer available.");
      await queryClient.invalidateQueries({ queryKey: gitKeys.savedRepos() });
    } finally {
    }
  };

  const handleCloneGithubRepo = async (repo: GithubRepo) => {
    setError(null);
    try {
      const localPath = await cloneRepoMutation.mutateAsync({
        name: repo.name,
        url: repo.ssh_url,
        repoLabel: repo.full_name,
        source: "github",
        repoId: repo.id,
      });
      onRepoSelect(localPath);
    } catch (err) {
      setError(String(err));
    }
  };

  const handleRemoveSavedRepo = async (repo: SavedRepo) => {
    setRemovingRepo(true);
    setError(null);
    try {
      await removeRepoMutation.mutateAsync(repo.path);
    } catch (err) {
      setError(`Could not remove the repository: ${String(err)}`);
    } finally {
      setRemovingRepo(false);
      setRepoToRemove(null);
    }
  };

  const filteredSavedRepos = useMemo(() => {
    const query = savedQuery.trim().toLowerCase();
    if (!query) {
      return savedRepos;
    }
    return savedRepos.filter((repo) => {
      const name = repo.name.toLowerCase();
      const path = repo.path.toLowerCase();
      return name.includes(query) || path.includes(query);
    });
  }, [savedRepos, savedQuery]);

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

  const visibleSavedRepos = showAllSaved
    ? filteredSavedRepos
    : filteredSavedRepos.slice(0, SAVED_PREVIEW_COUNT);

  const visibleGithubRepos = showAllGithub
    ? filteredGithubRepos
    : filteredGithubRepos.slice(0, GITHUB_PREVIEW_COUNT);

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
                Find your repository
              </h1>
              <p className="max-w-xl text-sm text-muted-foreground">
                Get started building
              </p>
            </div>
            <div className="flex flex-wrap gap-3 text-xs text-muted-foreground"></div>
          </div>
          <div className="flex items-center gap-2">
            <ThemeButton />
            {onCreateProject && (
              <Button
                size="sm"
                onClick={onCreateProject}
                className="normal-case tracking-normal"
              >
                <Plus className="h-4 w-4" />
                Create new project
              </Button>
            )}
            {onOpenSettings && (
              <Button
                variant="outline"
                size="sm"
                onClick={onOpenSettings}
                className="normal-case tracking-normal"
              >
                <Settings className="h-4 w-4" />
                Settings
              </Button>
            )}
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <Card
            className="border-border/60 bg-background/85 shadow-[0_20px_60px_rgba(15,23,42,0.08)] backdrop-blur animate-in fade-in slide-in-from-bottom-4"
            style={{ animationDuration: "750ms" }}
          >
            <CardHeader className="flex flex-col gap-4 border-b border-border/60 pb-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <CardTitle className="text-xl">Your repositories</CardTitle>
                  <CardDescription>
                    Pick up where you left off with fast local search.
                  </CardDescription>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleRefreshSavedRepos}
                  className="normal-case tracking-normal"
                >
                  Refresh
                </Button>
              </div>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={savedQuery}
                  onChange={(event) => setSavedQuery(event.target.value)}
                  placeholder="Search saved repositories by name or path"
                  className="pl-10"
                />
              </div>
            </CardHeader>
            <CardContent className="space-y-6 pt-6">
              <section className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-semibold text-foreground">
                    Saved on this device
                  </div>
                  <Badge variant="secondary" className="normal-case">
                    {filteredSavedRepos.length} total
                  </Badge>
                </div>

                {filteredSavedRepos.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-border/70 bg-muted/40 px-4 py-8 text-center text-sm text-muted-foreground">
                    No saved repositories yet. Clone one below to get started.
                  </div>
                ) : (
                  <div className="grid gap-3">
                    {visibleSavedRepos.map((repo) => (
                      <div
                        key={repo.path}
                        className="flex flex-col gap-4 rounded-2xl border border-border/60 bg-background/70 p-4 transition"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <div className="text-base font-semibold text-foreground">
                              {repo.name}
                            </div>
                            <div className="text-xs font-mono text-muted-foreground break-all">
                              {repo.path}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <Button
                              size="sm"
                              onClick={() =>
                                handleOpenSaved(repo.path, repo.name)
                              }
                              disabled={busy || removingRepo}
                              className="normal-case tracking-normal"
                            >
                              Open
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setRepoToRemove(repo)}
                              disabled={busy || removingRepo}
                              className="normal-case tracking-normal text-muted-foreground hover:text-destructive"
                            >
                              <Trash2 className="h-4 w-4" />
                              <span className="sr-only">Remove</span>
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {filteredSavedRepos.length > SAVED_PREVIEW_COUNT && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowAllSaved((prev) => !prev)}
                    className="normal-case tracking-normal"
                  >
                    {showAllSaved
                      ? "Show less"
                      : `Show ${
                          filteredSavedRepos.length - SAVED_PREVIEW_COUNT
                        } more`}
                    {showAllSaved ? (
                      <ChevronUp className="h-4 w-4" />
                    ) : (
                      <ChevronDown className="h-4 w-4" />
                    )}
                  </Button>
                )}
              </section>
            </CardContent>
          </Card>

          <div className="flex flex-col gap-6">
            <Card
              className="border-border/60 bg-background/85 shadow-[0_20px_60px_rgba(15,23,42,0.08)] backdrop-blur animate-in fade-in slide-in-from-bottom-4"
              style={{ animationDuration: "800ms" }}
            >
              <CardHeader className="border-b border-border/60 pb-5">
                <CardTitle className="text-xl">Clone from GitHub</CardTitle>
                <CardDescription>
                  Connect once to browse and clone repositories with SSH.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 pt-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  {githubConnected ? (
                    <div className="text-xs text-muted-foreground">
                      Connected as{" "}
                      <span className="font-semibold text-foreground">
                        {githubUser?.login ?? "GitHub user"}
                      </span>
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground">
                      Connect to see your repositories.
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleRefreshGithubRepos}
                      disabled={githubLoading || !githubConnected}
                      className="normal-case tracking-normal"
                    >
                      {githubLoading ? "Loading…" : "Refresh"}
                    </Button>
                    {onOpenSettings && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={onOpenSettings}
                        className="normal-case tracking-normal"
                      >
                        Manage
                      </Button>
                    )}
                  </div>
                </div>

                {githubConnected ? (
                  <>
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        value={githubQuery}
                        onChange={(event) => setGithubQuery(event.target.value)}
                        placeholder="Search GitHub repositories"
                        className="pl-10"
                      />
                    </div>

                    {githubLoading ? (
                      <div className="rounded-2xl border border-dashed border-border/70 bg-muted/40 px-4 py-6 text-center text-sm text-muted-foreground">
                        Loading repositories…
                      </div>
                    ) : filteredGithubRepos.length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-border/70 bg-muted/40 px-4 py-6 text-center text-sm text-muted-foreground">
                        {githubQuery.trim().length > 0
                          ? "No repositories match that search."
                          : "No repositories found in this account yet."}
                      </div>
                    ) : (
                      <div className="grid gap-3">
                        {visibleGithubRepos.map((repo) => (
                          <div
                            key={repo.id}
                            className="flex flex-col gap-3 rounded-2xl border border-border/60 bg-background/70 p-4"
                          >
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div>
                                <div className="text-sm font-semibold text-foreground">
                                  {repo.full_name}
                                </div>
                                <div className="text-xs text-muted-foreground break-all">
                                  {repo.ssh_url}
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                {repo.private && (
                                  <Badge variant="secondary">Private</Badge>
                                )}
                                {repo.fork && (
                                  <Badge variant="outline">Fork</Badge>
                                )}
                              </div>
                            </div>
                            <Button
                              onClick={() => void handleCloneGithubRepo(repo)}
                              disabled={busy || defaultRepoDirLoading}
                              className="normal-case tracking-normal"
                            >
                              {activeClone?.source === "github" &&
                              activeClone.repoId === repo.id
                                ? "Cloning…"
                                : "Clone"}
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}

                    {filteredGithubRepos.length > GITHUB_PREVIEW_COUNT && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setShowAllGithub((prev) => !prev)}
                        className="normal-case tracking-normal"
                      >
                        {showAllGithub
                          ? "Show less"
                          : `Show ${
                              filteredGithubRepos.length - GITHUB_PREVIEW_COUNT
                            } more`}
                        {showAllGithub ? (
                          <ChevronUp className="h-4 w-4" />
                        ) : (
                          <ChevronDown className="h-4 w-4" />
                        )}
                      </Button>
                    )}
                  </>
                ) : (
                  <div className="rounded-2xl border border-dashed border-border/70 bg-muted/40 px-4 py-6 text-sm text-muted-foreground">
                    <div className="space-y-3">
                      <div>
                        Sign in once and Falck will remember your GitHub access
                        token locally on this device.
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
                          className="normal-case tracking-normal"
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
                            className="normal-case tracking-normal"
                          >
                            Open GitHub
                          </Button>
                        )}
                      </div>
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
              style={{ animationDuration: "900ms" }}
            >
              <CardHeader className="border-b border-border/60 pb-5">
                <CardTitle className="text-xl">
                  Clone or open manually
                </CardTitle>
                <CardDescription>
                  Use an SSH URL or point Falck at a folder already on your
                  disk.
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-6">
                <Tabs defaultValue="clone" className="space-y-4">
                  <TabsList className="w-full justify-start bg-muted/60">
                    <TabsTrigger value="clone">Clone</TabsTrigger>
                    <TabsTrigger value="open">Open existing</TabsTrigger>
                  </TabsList>
                  <TabsContent value="clone">
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
                        disabled={
                          busy || defaultRepoDirLoading || !defaultRepoDir
                        }
                        className="w-full normal-case tracking-normal"
                      >
                        {activeClone?.source === "form" ? "Cloning…" : "Clone"}
                      </Button>
                    </form>
                  </TabsContent>
                  <TabsContent value="open">
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
                        disabled={busy}
                        className="w-full normal-case tracking-normal"
                      >
                        {openingRepo ? "Opening…" : "Open repo"}
                      </Button>
                    </form>
                  </TabsContent>
                </Tabs>
              </CardContent>
            </Card>
          </div>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>

      <Dialog
        open={Boolean(repoToRemove)}
        onOpenChange={(open) => {
          if (!open) {
            setRepoToRemove(null);
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Remove repository?</DialogTitle>
            <DialogDescription>
              This removes the repo from your recent list without deleting any
              files on disk.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRepoToRemove(null)}
              className="normal-case tracking-normal"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                repoToRemove ? void handleRemoveSavedRepo(repoToRemove) : null
              }
              disabled={removingRepo}
              className="normal-case tracking-normal"
            >
              {removingRepo ? "Removing…" : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
