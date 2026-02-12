import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { useStore } from "@tanstack/react-store";
import { listen } from "@tauri-apps/api/event";
import { join } from "@tauri-apps/api/path";
import { useEffect, useMemo, useState } from "react";
import { nanoid } from "nanoid";

import { FormField, FormSelect } from "@/components/form/FormField";
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useAppState } from "@/router/app-state";
import { createAstroProjectSchema } from "@/schemas/forms";
import {
  githubService,
  type GithubRepo,
  type GithubUser,
} from "@/services/githubService";
import { gitService } from "@/services/gitService";
import { projectService } from "@/services/projectService";
import { settingsService } from "@/services/settingsService";
import { ArrowLeft, ChevronDown } from "lucide-react";

const ASTRO_TEMPLATE = "MikkelWestermann/falck-astro";

type CreateProgressEvent = {
  progressId?: string | null;
  message?: string | null;
  detail?: string | null;
};

const normalizeSlug = (value: string) => {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return "";
  }
  return trimmed
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
};

export const Route = createFileRoute("/create/astro")({
  component: CreateAstroRoute,
});

function CreateAstroRoute() {
  const navigate = Route.useNavigate();
  const { sshKey, setRepoPath } = useAppState();
  const [defaultRepoDir, setDefaultRepoDir] = useState<string | null>(null);
  const [defaultRepoDirLoading, setDefaultRepoDirLoading] = useState(true);
  const [githubConnected, setGithubConnected] = useState(false);
  const [githubUser, setGithubUser] = useState<GithubUser | null>(null);
  const [githubRepos, setGithubRepos] = useState<GithubRepo[]>([]);
  const [githubLoading, setGithubLoading] = useState(false);
  const [githubError, setGithubError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [repoNameAuto, setRepoNameAuto] = useState(true);
  const [progressMessage, setProgressMessage] = useState(
    "Preparing to create your project...",
  );
  const [progressDetail, setProgressDetail] = useState<string | null>(null);

  const createForm = useForm({
    defaultValues: {
      projectName: "",
      repoMode: "new",
      repoName: "",
      existingRepo: "",
      visibility: "private",
      description: "",
      folderName: "",
      promptMode: "yes",
      installDependencies: true,
      initializeGit: false,
      skipHouston: true,
      integrations: "",
      astroRef: "",
    },
    validators: {
      onSubmit: createAstroProjectSchema,
    },
    onSubmit: async ({ value }) => {
      if (!sshKey) {
        setError("SSH key is required before creating projects.");
        return;
      }
      if (!defaultRepoDir) {
        setError("Set a default project folder in settings first.");
        return;
      }
      setError(null);
      setGithubError(null);
      const progressId = nanoid();
      setProgressMessage("Preparing to create your project...");
      setProgressDetail(null);
      setCreating(true);
      let unlisten: (() => void) | null = null;
      try {
        unlisten = await listen<CreateProgressEvent>(
          "create-project-progress",
          (event) => {
            const payload = event.payload;
            if (payload?.progressId && payload.progressId !== progressId) {
              return;
            }
            if (payload?.message) {
              setProgressMessage(payload.message);
            }
            if (payload?.detail !== undefined) {
              setProgressDetail(payload.detail ?? null);
            }
          },
        );
        const projectSlug = normalizeSlug(value.projectName);
        if (!projectSlug) {
          setError("Project name is required.");
          return;
        }

        const folderName =
          normalizeSlug(value.folderName ?? "") || projectSlug;
        const repoName = normalizeSlug(value.repoName ?? "") || projectSlug;
        const integrations = value.integrations?.trim();
        const astroRef = value.astroRef?.trim();

        if (!githubConnected) {
          setError("Connect GitHub before creating a new project.");
          return;
        }

        let repoFullName: string | null = null;
        let repoSshUrl: string | null = null;

        if (value.repoMode === "existing") {
          const selected = githubRepos.find(
            (repo) => repo.full_name === value.existingRepo,
          );
          if (!selected) {
            setError("Select a GitHub repository to continue.");
            return;
          }
          repoFullName = selected.full_name;
          repoSshUrl = selected.ssh_url;
        }

        const localPath = await join(defaultRepoDir, folderName);
        const result = await projectService.createAstroProject({
          projectName: value.projectName.trim(),
          localPath,
          repoMode: value.repoMode === "existing" ? "existing" : "new",
          repoName: value.repoMode === "new" ? repoName : null,
          repoFullName,
          repoSshUrl,
          repoVisibility: value.visibility,
          description: value.description?.trim() || null,
          sshKeyPath: sshKey.private_key_path,
          promptMode: value.promptMode,
          installDependencies: value.installDependencies,
          initializeGit: value.initializeGit,
          skipHouston: value.skipHouston,
          integrations: integrations ? integrations : null,
          astroRef: astroRef ? astroRef : null,
          progressId,
        });

        await gitService.saveRepo(
          result.repoFullName || result.repoName,
          result.path,
        );
        setRepoPath(result.path);
        navigate({ to: "/overview" });
      } catch (err) {
        setError(String(err));
      } finally {
        if (unlisten) {
          unlisten();
        }
        setCreating(false);
      }
    },
  });

  const formValues = useStore(createForm.store, (state) => state.values);
  const projectSlug = normalizeSlug(formValues.projectName ?? "");
  const repoMode = formValues.repoMode ?? "new";

  useEffect(() => {
    let active = true;
    settingsService
      .getDefaultRepoDir()
      .then((dir) => {
        if (active) {
          setDefaultRepoDir(dir);
        }
      })
      .catch((err) => {
        if (active) {
          setError(`Failed to load default folder: ${String(err)}`);
        }
      })
      .finally(() => {
        if (active) {
          setDefaultRepoDirLoading(false);
        }
      });

    githubService
      .hasToken()
      .then((hasToken) => {
        if (!active) return;
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
        if (!active) return;
        setGithubConnected(false);
        setGithubError(`GitHub auth unavailable: ${String(err)}`);
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (
      formValues.repoMode !== "existing" ||
      !githubConnected ||
      githubRepos.length > 0 ||
      githubLoading
    ) {
      return;
    }

    const loadRepos = async () => {
      setGithubLoading(true);
      setGithubError(null);
      try {
        const repos = await githubService.listRepos();
        setGithubRepos(repos);
      } catch (err) {
        setGithubError(String(err));
      } finally {
        setGithubLoading(false);
      }
    };

    void loadRepos();
  }, [formValues.repoMode, githubConnected, githubRepos.length, githubLoading]);

  useEffect(() => {
    if (!repoNameAuto || repoMode !== "new") {
      return;
    }
    if (formValues.repoName === projectSlug) {
      return;
    }
    createForm.setFieldValue("repoName", projectSlug);
  }, [
    repoNameAuto,
    repoMode,
    projectSlug,
    createForm,
    formValues.repoName,
  ]);

  const repoSlug = normalizeSlug(formValues.repoName ?? "") || projectSlug;
  const folderSlug =
    normalizeSlug(formValues.folderName ?? "") || projectSlug;
  const pathPreview = useMemo(() => {
    if (!defaultRepoDir) {
      return "";
    }
    const folder = folderSlug || "project";
    const separator = defaultRepoDir.includes("\\") ? "\\" : "/";
    const base = defaultRepoDir.replace(/[\\/]+$/, "");
    const suffix = folder.replace(/^[\\/]+/, "");
    return suffix ? `${base}${separator}${suffix}` : base;
  }, [defaultRepoDir, folderSlug]);
  const repoOptions = useMemo(
    () =>
      githubRepos.map((repo) => ({
        label: repo.full_name,
        value: repo.full_name,
      })),
    [githubRepos],
  );

  if (!sshKey) {
    return <Navigate to="/ssh" />;
  }

  if (creating) {
    return (
      <CreateProgressScreen
        message={progressMessage}
        detail={progressDetail}
      />
    );
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-page-background text-foreground">
      <div className="relative mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-10 lg:py-14">
        <header className="flex flex-col gap-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate({ to: "/create" })}
            className="w-fit"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to templates
          </Button>
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-3xl font-semibold text-foreground">
                Astro marketing site
              </h1>
              <Badge variant="secondary">Template</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              Configure the project and Falck will scaffold, push, and open it
              for you.
            </p>
          </div>
        </header>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void createForm.handleSubmit();
          }}
          className="space-y-6"
        >
          <Card className="border-border/60 bg-background/85 shadow-[0_20px_60px_rgba(15,23,42,0.08)] backdrop-blur">
            <CardHeader className="space-y-2">
              <CardTitle className="text-xl">Basic settings</CardTitle>
              <CardDescription>
                Choose a name and GitHub destination for the new project.
              </CardDescription>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant={githubConnected ? "secondary" : "destructive"}>
                  {githubConnected
                    ? `GitHub connected${githubUser ? ` as ${githubUser.login}` : ""}`
                    : "GitHub not connected"}
                </Badge>
                <Badge variant="outline">Template: {ASTRO_TEMPLATE}</Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              <createForm.Field name="projectName">
                {(field) => (
                  <FormField
                    field={field}
                    label="Project name"
                    placeholder="Falck marketing site"
                    required
                  />
                )}
              </createForm.Field>

              <div className="grid gap-4 md:grid-cols-2">
                <createForm.Field name="repoMode">
                  {(field) => (
                    <FormSelect
                      field={field}
                      label="GitHub repository"
                      required
                      options={[
                        { label: "Create new repo", value: "new" },
                        { label: "Use existing repo", value: "existing" },
                      ]}
                    />
                  )}
                </createForm.Field>
                {repoMode === "new" ? (
                  <createForm.Field name="repoName">
                    {(field) => (
                      <FormField
                        field={field}
                        label="Repository name"
                        placeholder={projectSlug || "falck-marketing-site"}
                        onValueChange={(value) => {
                          const normalized = normalizeSlug(value);
                          setRepoNameAuto(
                            value.trim() === "" || normalized === projectSlug,
                          );
                        }}
                        helpText={
                          repoSlug
                            ? `Defaults to ${repoSlug}`
                            : "Defaults to project name"
                        }
                      />
                    )}
                  </createForm.Field>
                ) : (
                  <createForm.Field name="existingRepo">
                    {(field) => (
                      <FormSelect
                        field={field}
                        label="Select repository"
                        required
                        options={
                          repoOptions.length > 0
                            ? repoOptions
                            : [{ label: "Loading repositories...", value: "" }]
                        }
                      />
                    )}
                  </createForm.Field>
                )}
              </div>

              <div className="space-y-2 text-sm">
                <div className="font-medium">Destination folder</div>
                <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs font-mono text-muted-foreground">
                  {defaultRepoDirLoading
                    ? "Loading..."
                    : pathPreview ||
                      "Set a default project folder in settings."}
                </div>
                <p className="text-xs text-muted-foreground">
                  Change the default folder in Settings if needed.
                </p>
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/60 bg-background/85 shadow-[0_16px_40px_rgba(15,23,42,0.06)] backdrop-blur">
            <CardHeader>
              <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
                <CollapsibleTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="-ml-2 h-auto px-2 py-1.5 text-muted-foreground hover:text-foreground"
                    type="button"
                  >
                    Advanced settings
                    <ChevronDown
                      className={`h-4 w-4 transition ${
                        advancedOpen ? "rotate-180" : ""
                      }`}
                    />
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <CardDescription className="mt-3">
                    Tune repository details and Astro scaffolding options.
                  </CardDescription>
                  <div className="mt-4 grid gap-4 md:grid-cols-2">
                    <createForm.Field name="visibility">
                      {(field) => (
                        <FormSelect
                          field={field}
                          label="Repository visibility"
                          required
                          options={[
                            { label: "Private", value: "private" },
                            { label: "Public", value: "public" },
                          ]}
                        />
                      )}
                    </createForm.Field>
                    <createForm.Field name="folderName">
                      {(field) => (
                        <FormField
                          field={field}
                          label="Folder name"
                          placeholder={projectSlug || "falck-marketing-site"}
                          helpText={
                            folderSlug
                              ? `Defaults to ${folderSlug}`
                              : "Defaults to project name"
                          }
                        />
                      )}
                    </createForm.Field>
                    <div className="md:col-span-2">
                      <createForm.Field name="description">
                        {(field) => (
                          <FormField
                            field={field}
                            label="Repository description"
                            placeholder="Marketing site for Falck"
                            helpText="Optional, shown on GitHub."
                          />
                        )}
                      </createForm.Field>
                    </div>
                  </div>
                  <div className="mt-6 space-y-4 rounded-xl border border-border/60 bg-muted/30 p-4">
                    <div className="space-y-1">
                      <p className="text-sm font-semibold">Astro scaffolding</p>
                      <p className="text-xs text-muted-foreground">
                        Flags keep create-astro non-interactive by default.
                      </p>
                    </div>
                    <div className="grid gap-4 md:grid-cols-2">
                      <createForm.Field name="promptMode">
                        {(field) => (
                          <FormSelect
                            field={field}
                            label="Prompt mode"
                            required
                            options={[
                              { label: "Accept defaults (--yes)", value: "yes" },
                              { label: "Decline defaults (--no)", value: "no" },
                            ]}
                          />
                        )}
                      </createForm.Field>
                      <createForm.Field name="astroRef">
                        {(field) => (
                          <FormField
                            field={field}
                            label="Astro ref"
                            placeholder="latest"
                            helpText="Optional Astro version or branch."
                          />
                        )}
                      </createForm.Field>
                      <div className="md:col-span-2">
                        <createForm.Field name="integrations">
                          {(field) => (
                            <FormField
                              field={field}
                              label="Integrations"
                              placeholder="tailwind, react"
                              helpText="Comma-separated list passed to --add."
                            />
                          )}
                        </createForm.Field>
                      </div>
                    </div>
                    <div className="grid gap-3 md:grid-cols-3">
                      <createForm.Field name="installDependencies">
                        {(field) => {
                          const id = `${field.name}-toggle`;
                          return (
                            <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/70 px-3 py-2">
                              <div className="space-y-1">
                                <Label htmlFor={id} className="text-sm font-medium">
                                  Install dependencies
                                </Label>
                                <p className="text-xs text-muted-foreground">
                                  Run the package install automatically.
                                </p>
                              </div>
                              <Switch
                                id={id}
                                checked={Boolean(field.state.value)}
                                onCheckedChange={field.handleChange}
                              />
                            </div>
                          );
                        }}
                      </createForm.Field>
                      <createForm.Field name="initializeGit">
                        {(field) => {
                          const id = `${field.name}-toggle`;
                          return (
                            <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/70 px-3 py-2">
                              <div className="space-y-1">
                                <Label htmlFor={id} className="text-sm font-medium">
                                  Initialize git
                                </Label>
                                <p className="text-xs text-muted-foreground">
                                  Let Astro run git init before Falck.
                                </p>
                              </div>
                              <Switch
                                id={id}
                                checked={Boolean(field.state.value)}
                                onCheckedChange={field.handleChange}
                              />
                            </div>
                          );
                        }}
                      </createForm.Field>
                      <createForm.Field name="skipHouston">
                        {(field) => {
                          const id = `${field.name}-toggle`;
                          return (
                            <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/70 px-3 py-2">
                              <div className="space-y-1">
                                <Label htmlFor={id} className="text-sm font-medium">
                                  Skip Houston
                                </Label>
                                <p className="text-xs text-muted-foreground">
                                  Skip the CLI animation.
                                </p>
                              </div>
                              <Switch
                                id={id}
                                checked={Boolean(field.state.value)}
                                onCheckedChange={field.handleChange}
                              />
                            </div>
                          );
                        }}
                      </createForm.Field>
                    </div>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </CardHeader>
          </Card>

          {githubLoading && (
            <Alert>
              <AlertDescription>Loading GitHub repositories...</AlertDescription>
            </Alert>
          )}
          {githubError && (
            <Alert variant="destructive">
              <AlertDescription>{githubError}</AlertDescription>
            </Alert>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-muted-foreground">
              Creates the project, initializes Git, pushes to GitHub, and opens
              the repo in Falck.
            </div>
            <Button
              type="submit"
              disabled={
                creating ||
                defaultRepoDirLoading ||
                !defaultRepoDir ||
                !githubConnected
              }
              className="min-w-[180px] normal-case tracking-normal"
            >
              {creating ? "Creating..." : "Create project"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CreateProgressScreen({
  message,
  detail,
}: {
  message: string;
  detail: string | null;
}) {
  return (
    <div className="relative min-h-screen overflow-hidden text-white">
      <div className="create-loading-backdrop absolute inset-0" />
      <div className="create-loading-glow absolute inset-0" />
      <div className="relative z-10 flex min-h-screen items-center justify-center px-6 text-center">
        <div className="flex max-w-xl flex-col items-center gap-6">
          <div className="create-loading-orb">
            <div className="create-loading-core" />
          </div>
          <div className="space-y-2">
            <h2 className="text-2xl font-semibold tracking-tight">
              {message}
            </h2>
            {detail && (
              <p className="text-xs font-mono text-white/70">{detail}</p>
            )}
          </div>
          <p className="text-sm text-white/70">
            Hang tight, we are setting everything up for you.
          </p>
        </div>
      </div>
    </div>
  );
}
