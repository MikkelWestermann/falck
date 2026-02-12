import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CommitInfo, gitService } from "@/services/gitService";

interface CommitHistoryProps {
  repoPath: string;
  baseBranch: string;
  currentBranch: string;
  hasUnsavedChanges?: boolean;
  onRestored?: () => void;
}

export function CommitHistory({
  repoPath,
  baseBranch,
  currentBranch,
  hasUnsavedChanges = false,
  onRestored,
}: CommitHistoryProps) {
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<CommitInfo | null>(null);
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  useEffect(() => {
    void loadCommits();
  }, [repoPath, baseBranch, currentBranch]);

  const loadCommits = async () => {
    setLoading(true);
    setError(null);
    try {
      const history = await gitService.getProjectHistory(
        repoPath,
        baseBranch,
        50,
      );
      setCommits(history);
    } catch (err) {
      const message = String(err);
      if (message.toLowerCase().includes("branch")) {
        setError("Default project not found. Check your Falck config.");
      } else {
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (timestamp: number) =>
    new Date(timestamp * 1000).toLocaleString();

  const handleRestore = async () => {
    if (!restoreTarget) {
      return;
    }
    setRestoreLoading(true);
    setRestoreError(null);
    try {
      const info = await gitService.getRepositoryInfo(repoPath);
      if (info.is_dirty) {
        setRestoreError(
          "Please save or discard your changes before restoring a version.",
        );
        return;
      }
      await gitService.resetToCommit(repoPath, restoreTarget.id);
      setRestoreTarget(null);
      await loadCommits();
      onRestored?.();
    } catch (err) {
      setRestoreError(String(err));
    } finally {
      setRestoreLoading(false);
    }
  };

  return (
    <div>
      {/* <Button variant="ghost" size="sm" onClick={loadCommits}>
        <RefreshCw className="h-3 w-3" />
      </Button> */}
      <div>
        {loading ? (
          <div className="rounded-lg border-2 border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
            Loading history…
          </div>
        ) : error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : commits.length === 0 ? (
          <div className="rounded-lg border-2 border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
            No saved versions found.
          </div>
        ) : (
          <div className="space-y-3">
            {commits.map((commit) => (
              <div
                key={commit.id}
                className="flex flex-col gap-2 rounded-lg border-2 border-border bg-card/80 p-4 shadow-[var(--shadow-xs)] sm:flex-row sm:items-start"
              >
                <Badge variant="outline" className="w-fit font-mono">
                  {commit.id.substring(0, 7)}
                </Badge>
                <div>
                  <div className="text-sm font-semibold text-foreground">
                    {commit.message}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {commit.author} · {formatDate(commit.timestamp)}
                  </div>
                </div>
                <div className="ml-auto">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setRestoreTarget(commit)}
                    disabled={hasUnsavedChanges}
                  >
                    Restore
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog
        open={Boolean(restoreTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setRestoreTarget(null);
            setRestoreError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore this version?</DialogTitle>
            <DialogDescription>
              Restoring will delete any newer saves on this project.
            </DialogDescription>
          </DialogHeader>
          {restoreError && (
            <Alert variant="destructive">
              <AlertDescription>{restoreError}</AlertDescription>
            </Alert>
          )}
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setRestoreTarget(null)}
              disabled={restoreLoading}
            >
              Cancel
            </Button>
            <Button onClick={handleRestore} disabled={restoreLoading}>
              {restoreLoading ? "Restoring..." : "Restore version"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
