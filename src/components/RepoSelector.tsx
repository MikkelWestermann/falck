import { useEffect, useState } from "react";
import { useForm } from "@tanstack/react-form";
import { zodValidator } from "@tanstack/zod-form-adapter";

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
import { cloneRepoSchema, openRepoSchema } from "@/schemas/forms";
import { gitService } from "@/services/gitService";
import logo from "@/assets/logo.png";

interface RepoSelectorProps {
  onRepoSelect: (path: string) => void;
}

export function RepoSelector({ onRepoSelect }: RepoSelectorProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedRepos, setSavedRepos] = useState<
    Awaited<ReturnType<typeof gitService.listSavedRepos>>
  >([]);

  useEffect(() => {
    void loadSavedRepos();
  }, []);

  const loadSavedRepos = async () => {
    try {
      const repos = await gitService.listSavedRepos();
      setSavedRepos(repos);
    } catch (err) {
      console.error("Failed to load saved repos:", err);
    }
  };

  const cloneForm = useForm({
    defaultValues: {
      name: "",
      url: "",
      localPath: "",
    },
    onSubmit: async ({ value }) => {
      setLoading(true);
      setError(null);
      try {
        await gitService.cloneRepository(value.url, value.localPath);
        await gitService.saveRepo(value.name, value.localPath);
        onRepoSelect(value.localPath);
        cloneForm.reset();
        await loadSavedRepos();
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    },
    validatorAdapter: zodValidator(),
  });

  const openForm = useForm({
    defaultValues: {
      name: "",
      path: "",
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
    validatorAdapter: zodValidator(),
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

  return (
    <div className="min-h-screen">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-10">
        <header
          className="relative overflow-hidden border-2 border-border bg-card pr-6 pl-16 py-7 shadow-[var(--shadow-lg)]"
          data-tauri-drag-region
        >
          <div className="absolute inset-x-0 top-0 h-2 bg-primary" />
          <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
            <div className="flex items-start gap-4">
              <div className="flex h-12 w-12 items-center justify-center border-2 border-border bg-primary shadow-[var(--shadow-sm)]">
                <img
                  src={logo}
                  alt="Falck logo"
                  className="h-7 w-7 object-contain"
                />
              </div>
              <div className="max-w-2xl space-y-3">
                <p className="text-xs font-semibold uppercase tracking-[0.4em] text-foreground">
                  Falck
                </p>
                <h1 className="text-3xl font-black uppercase leading-tight tracking-tight md:text-4xl">
                  Ship commits with calm.
                </h1>
                <p className="text-base text-muted-foreground">
                  Clone a new repo or open an existing one to explore history,
                  stage files, and push updates without leaving your desktop.
                </p>
              </div>
            </div>
            <div className="grid gap-2 text-right">
              <Badge variant="secondary" className="justify-center">
                Tauri + React
              </Badge>
              <Badge variant="secondary" className="justify-center">
                Local-first
              </Badge>
              <Badge variant="secondary" className="justify-center">
                No CLI required
              </Badge>
            </div>
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Clone repository</CardTitle>
              <CardDescription>
                Start from a remote URL and choose a local destination.
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
                <cloneForm.Field
                  name="name"
                  validators={{
                    onChange: zodValidator(cloneRepoSchema.shape.name),
                  }}
                >
                  {(field) => (
                    <FormField
                      field={field}
                      label="Repo name"
                      placeholder="Marketing site"
                      required
                    />
                  )}
                </cloneForm.Field>
                <cloneForm.Field
                  name="url"
                  validators={{
                    onChange: zodValidator(cloneRepoSchema.shape.url),
                  }}
                >
                  {(field) => (
                    <FormField
                      field={field}
                      label="Repository URL"
                      placeholder="https://github.com/user/repo.git"
                      required
                    />
                  )}
                </cloneForm.Field>
                <cloneForm.Field
                  name="localPath"
                  validators={{
                    onChange: zodValidator(cloneRepoSchema.shape.localPath),
                  }}
                >
                  {(field) => (
                    <FormField
                      field={field}
                      label="Local path"
                      placeholder="/Users/you/dev/repo"
                      required
                    />
                  )}
                </cloneForm.Field>
                <Button type="submit" disabled={loading} className="w-full">
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
                <openForm.Field
                  name="name"
                  validators={{
                    onChange: zodValidator(openRepoSchema.shape.name),
                  }}
                >
                  {(field) => (
                    <FormField
                      field={field}
                      label="Repo name"
                      placeholder="Internal tools"
                      required
                    />
                  )}
                </openForm.Field>
                <openForm.Field
                  name="path"
                  validators={{
                    onChange: zodValidator(openRepoSchema.shape.path),
                  }}
                >
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
                    className="group flex w-full items-center justify-between gap-4 rounded-lg border-2 border-border bg-card/70 px-4 py-3 text-left shadow-[var(--shadow-xs)] transition hover:-translate-y-0.5 hover:bg-secondary/20 active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
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
                    <Badge variant="muted">
                      Open
                    </Badge>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>
    </div>
  );
}
