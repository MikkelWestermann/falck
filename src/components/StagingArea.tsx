import { useEffect, useState } from "react";
import { useForm } from "@tanstack/react-form";
import { zodValidator } from "@tanstack/zod-form-adapter";

import { FormField, FormTextarea } from "@/components/form/FormField";
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
import { commitSchema } from "@/schemas/forms";
import { FileStatus, gitService } from "@/services/gitService";

interface StagingAreaProps {
  repoPath: string;
  onCommit: () => void;
}

const statusLabel: Record<FileStatus["status"], string> = {
  modified: "Modified",
  added: "Added",
  deleted: "Deleted",
  renamed: "Renamed",
  untracked: "Untracked",
  unknown: "Unknown",
};

const statusVariant: Record<FileStatus["status"], "default" | "secondary" | "destructive" | "outline" | "muted"> = {
  modified: "secondary",
  added: "default",
  deleted: "destructive",
  renamed: "secondary",
  untracked: "outline",
  unknown: "muted",
};

export function StagingArea({ repoPath, onCommit }: StagingAreaProps) {
  const [files, setFiles] = useState<FileStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadStatus();
  }, [repoPath]);

  const loadStatus = async () => {
    try {
      const info = await gitService.getRepositoryInfo(repoPath);
      setFiles(info.status_files);
    } catch (err) {
      console.error("Failed to load status:", err);
    }
  };

  const handleStageFile = async (filePath: string) => {
    try {
      await gitService.stageFile(repoPath, filePath);
      await loadStatus();
    } catch (err) {
      setError(String(err));
    }
  };

  const commitForm = useForm({
    defaultValues: {
      author: "Your Name",
      email: "you@example.com",
      message: "",
    },
    onSubmit: async ({ value }) => {
      if (files.length === 0) {
        setError("No changes to commit.");
        return;
      }
      setLoading(true);
      setError(null);
      try {
        await gitService.createCommit(repoPath, value.message, value.author, value.email);
        commitForm.reset();
        await loadStatus();
        onCommit();
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    },
    validatorAdapter: zodValidator(),
  });

  const hasChanges = files.length > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Staging area</CardTitle>
        <CardDescription>Pick files to stage and craft a commit.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {!hasChanges ? (
          <div className="rounded-lg border-2 border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
            No changes to commit.
          </div>
        ) : (
          <div className="space-y-2">
            {files.map((file) => (
              <div
                key={file.path}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border-2 border-border bg-card/80 px-4 py-3 shadow-[var(--shadow-xs)]"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <Badge variant={statusVariant[file.status]}>
                    {statusLabel[file.status]}
                  </Badge>
                  <span className="truncate text-sm font-mono text-foreground/80">
                    {file.path}
                  </span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleStageFile(file.path)}
                >
                  Stage
                </Button>
              </div>
            ))}
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void commitForm.handleSubmit();
          }}
          className="space-y-4 rounded-lg border-2 border-dashed border-border/70 bg-secondary/20 p-4 shadow-[var(--shadow-xs)]"
        >
          <h3 className="text-base font-semibold">Create commit</h3>
          <commitForm.Field
            name="author"
            validators={{ onChange: zodValidator(commitSchema.shape.author) }}
          >
            {(field) => (
              <FormField field={field} label="Author name" required />
            )}
          </commitForm.Field>
          <commitForm.Field
            name="email"
            validators={{ onChange: zodValidator(commitSchema.shape.email) }}
          >
            {(field) => (
              <FormField field={field} label="Author email" type="email" required />
            )}
          </commitForm.Field>
          <commitForm.Field
            name="message"
            validators={{ onChange: zodValidator(commitSchema.shape.message) }}
          >
            {(field) => (
              <FormTextarea
                field={field}
                label="Commit message"
                placeholder="Summarize what changed"
                required
              />
            )}
          </commitForm.Field>
          <Button type="submit" disabled={loading || !hasChanges} className="w-full">
            {loading ? "Committing…" : "Commit"}
          </Button>
        </form>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
