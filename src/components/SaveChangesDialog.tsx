import { useEffect, useMemo, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { commitSchema } from "@/schemas/forms";
import { FileStatus, gitService } from "@/services/gitService";

interface SaveChangesDialogProps {
  repoPath: string;
  currentBranch: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

const statusLabel: Record<FileStatus["status"], string> = {
  modified: "Modified",
  added: "Added",
  deleted: "Deleted",
  renamed: "Renamed",
  untracked: "Untracked",
  unknown: "Unknown",
};

const statusVariant: Record<
  FileStatus["status"],
  "default" | "secondary" | "destructive" | "outline"
> = {
  modified: "secondary",
  added: "default",
  deleted: "destructive",
  renamed: "secondary",
  untracked: "outline",
  unknown: "secondary",
};

export function SaveChangesDialog({
  repoPath,
  currentBranch,
  open,
  onOpenChange,
  onSaved,
}: SaveChangesDialogProps) {
  const [files, setFiles] = useState<FileStatus[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [commitMessage, setCommitMessage] = useState("");
  const [author, setAuthor] = useState("Your Name");
  const [email, setEmail] = useState("you@example.com");
  const [remotes, setRemotes] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pushTarget = useMemo(() => {
    if (remotes.length === 0) {
      return null;
    }
    if (remotes.includes("origin")) {
      return "origin";
    }
    return remotes[0];
  }, [remotes]);

  const loadStatus = async () => {
    try {
      const info = await gitService.getRepositoryInfo(repoPath);
      setFiles(info.status_files);
      setSelectedFiles(new Set(info.status_files.map((file) => file.path)));
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  };

  const loadRemotes = async () => {
    try {
      const remoteList = await gitService.getRemotes(repoPath);
      setRemotes(remoteList);
    } catch (err) {
      setError(String(err));
    }
  };

  useEffect(() => {
    if (!open) {
      setError(null);
      return;
    }
    setCommitMessage("");
    void loadStatus();
    void loadRemotes();
  }, [open, repoPath]);

  const toggleFile = (filePath: string) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
  };

  const handleSelectAll = () => {
    setSelectedFiles(new Set(files.map((file) => file.path)));
  };

  const handleClearAll = () => {
    setSelectedFiles(new Set());
  };

  const handleSave = async () => {
    const details = {
      message: commitMessage.trim(),
      author: author.trim(),
      email: email.trim(),
    };

    const validation = commitSchema.safeParse(details);
    if (!validation.success) {
      setError(
        validation.error.issues[0]?.message ?? "Invalid commit details.",
      );
      return;
    }

    if (selectedFiles.size === 0) {
      setError("Select at least one file to stage.");
      return;
    }

    if (!pushTarget) {
      setError("No remotes configured to push to.");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      for (const file of files) {
        if (selectedFiles.has(file.path)) {
          await gitService.stageFile(repoPath, file.path);
        }
      }
      await gitService.createCommit(
        repoPath,
        details.message,
        details.author,
        details.email,
      );
      await gitService.push(repoPath, pushTarget, currentBranch);
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const selectedCount = selectedFiles.size;
  const totalCount = files.length;
  const hasChanges = totalCount > 0;
  const canSave =
    !loading &&
    hasChanges &&
    selectedCount > 0 &&
    commitMessage.trim().length > 0 &&
    Boolean(pushTarget);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Save changes</DialogTitle>
          <DialogDescription>
            Stage what matters, write the message, and push it upstream.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <Label className="text-xs text-muted-foreground">
                  Files to stage
                </Label>
                <div className="text-sm font-semibold text-foreground">
                  {selectedCount} of {totalCount} selected
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSelectAll}
                  disabled={!hasChanges}
                >
                  Select all
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleClearAll}
                  disabled={!hasChanges}
                >
                  Clear
                </Button>
              </div>
            </div>

            {!hasChanges ? (
              <div className="rounded-lg border-2 border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
                No changes to stage.
              </div>
            ) : (
              <div className="max-h-72 space-y-2 overflow-y-auto pr-2">
                {files.map((file) => (
                  <label
                    key={file.path}
                    className="flex cursor-pointer items-center gap-3 rounded-lg border-2 border-border bg-card/80 px-3 py-2 shadow-[var(--shadow-xs)] transition hover:bg-secondary/20"
                  >
                    <input
                      type="checkbox"
                      checked={selectedFiles.has(file.path)}
                      onChange={() => toggleFile(file.path)}
                      className="h-4 w-4 rounded border-2 border-border text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    <Badge variant={statusVariant[file.status]}>
                      {statusLabel[file.status]}
                    </Badge>
                    <span className="truncate text-sm font-mono text-foreground/80">
                      {file.path}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-4">
            <div className="rounded-lg border-2 border-border bg-secondary/10 p-4 shadow-[var(--shadow-xs)]">
              <Label
                htmlFor="commit-message"
                className="text-xs text-muted-foreground"
              >
                Commit message
              </Label>
              <Textarea
                id="commit-message"
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.target.value)}
                placeholder="Describe what changed"
                className="mt-2 min-h-[120px]"
              />
            </div>

            <div className="rounded-lg border-2 border-border bg-card/80 p-4 shadow-[var(--shadow-xs)]">
              <Label className="text-xs text-muted-foreground">
                Commit identity
              </Label>
              <div className="mt-3 space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="commit-author">Author name</Label>
                  <Input
                    id="commit-author"
                    value={author}
                    onChange={(event) => setAuthor(event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="commit-email">Author email</Label>
                  <Input
                    id="commit-email"
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </div>
              </div>
            </div>

            <div className="rounded-lg border-2 border-border bg-secondary/15 p-4 shadow-[var(--shadow-xs)]">
              <Label className="text-xs text-muted-foreground">
                Push target
              </Label>
              <div className="mt-2 text-sm font-semibold text-foreground">
                {pushTarget
                  ? `${pushTarget}/${currentBranch}`
                  : "No remotes configured"}
              </div>
              {!pushTarget && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Add a remote before using save.
                </p>
              )}
            </div>
          </div>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!canSave}>
            {loading ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
