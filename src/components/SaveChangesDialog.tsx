import { useEffect, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { commitSchema } from "@/schemas/forms";
import { FileStatus, gitService } from "@/services/gitService";

interface SaveChangesDialogProps {
  repoPath: string;
  currentBranch: string;
  defaultBranch?: string;
  protectDefaultBranch?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

const statusLabel: Record<FileStatus["status"], string> = {
  modified: "Modified",
  added: "Added",
  deleted: "Deleted",
  renamed: "Renamed",
  untracked: "New",
  unknown: "Changed",
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
  defaultBranch,
  protectDefaultBranch = false,
  open,
  onOpenChange,
  onSaved,
}: SaveChangesDialogProps) {
  const [files, setFiles] = useState<FileStatus[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [commitMessage, setCommitMessage] = useState("");
  const [remotes, setRemotes] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showFiles, setShowFiles] = useState(false);

  const pushTarget =
    remotes.length === 0
      ? null
      : remotes.includes("origin")
        ? "origin"
        : remotes[0];

  const saveBlocked = protectDefaultBranch && defaultBranch === currentBranch;

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
    setShowFiles(false);
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
    const validation = commitSchema.safeParse({
      message: commitMessage.trim(),
    });
    if (!validation.success) {
      setError(
        validation.error.issues[0]?.message ??
          "Please describe what you changed.",
      );
      return;
    }

    if (saveBlocked) {
      setError(
        "Saving is disabled on the default project. Switch to another project to save.",
      );
      return;
    }

    if (selectedFiles.size === 0) {
      setError("Select at least one change to include.");
      return;
    }

    if (!pushTarget) {
      setError("No sync destination configured.");
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
      await gitService.createCommit(repoPath, validation.data.message, "", "");
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
    Boolean(pushTarget) &&
    !saveBlocked;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-0 border-0 bg-background/95 p-0 shadow-xl backdrop-blur sm:rounded-2xl">
        <DialogHeader className="space-y-1.5 px-6 pt-6">
          <DialogTitle className="text-xl font-semibold tracking-tight">
            Save your changes
          </DialogTitle>
          <DialogDescription className="text-base text-muted-foreground">
            Add a short note so you remember what you did.
          </DialogDescription>
        </DialogHeader>

        {saveBlocked && (
          <Alert variant="destructive" className="mx-6 mt-4">
            <AlertDescription>
              Saving is disabled on the default project. Switch to another
              project to save.
            </AlertDescription>
          </Alert>
        )}

        <div className="px-6 pt-5">
          <label
            htmlFor="save-message"
            className="text-sm font-medium text-foreground"
          >
            What did you change?
          </label>
          <Textarea
            id="save-message"
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            placeholder="e.g. Fixed the login button, updated the readme"
            className="mt-2 min-h-[88px] resize-none rounded-xl border-2 border-input bg-muted/30 text-base placeholder:text-muted-foreground focus-visible:ring-2"
            autoFocus
          />
        </div>

        {hasChanges && (
          <Collapsible
            open={showFiles}
            onOpenChange={setShowFiles}
            className="mt-4 px-6"
          >
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="-ml-2 h-auto px-2 py-1.5 text-muted-foreground hover:text-foreground"
              >
                {showFiles ? "Hide" : "Choose what to include"} ({selectedCount}{" "}
                of {totalCount} selected)
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSelectAll}
                  className="h-8 text-xs"
                >
                  Select all
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleClearAll}
                  className="h-8 text-xs"
                >
                  Clear
                </Button>
              </div>
              <div className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-lg border border-border/80 bg-muted/20 p-2">
                {files.map((file) => (
                  <label
                    key={file.path}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted/50"
                  >
                    <input
                      type="checkbox"
                      checked={selectedFiles.has(file.path)}
                      onChange={() => toggleFile(file.path)}
                      className="h-3.5 w-3.5 rounded border-2 border-muted-foreground/50 text-primary focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    <Badge
                      variant={statusVariant[file.status]}
                      className="shrink-0 text-[10px] font-medium"
                    >
                      {statusLabel[file.status]}
                    </Badge>
                    <span className="truncate text-muted-foreground">
                      {file.path}
                    </span>
                  </label>
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}

        {!hasChanges && (
          <p className="px-6 pt-2 text-sm text-muted-foreground">
            No changes to save.
          </p>
        )}

        {error && (
          <Alert variant="destructive" className="mx-6 mt-4">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <DialogFooter className="mt-6 flex-row gap-2 border-t bg-muted/20 px-6 py-4 sm:justify-end sm:rounded-b-2xl">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
            className="rounded-xl"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={!canSave}
            className="rounded-xl"
          >
            {loading ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
