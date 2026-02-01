import { useEffect, useState } from "react";
import { useForm } from "@tanstack/react-form";

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
    validators: {
      onSubmit: cloneRepoSchema,
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
  });

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

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Clone repository</CardTitle>
              <CardDescription>
                Start from an SSH URL and choose a local destination.
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
                <cloneForm.Field name="localPath">
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

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>
    </div>
  );
}
