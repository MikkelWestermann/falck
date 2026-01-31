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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CommitHistory } from "@/components/CommitHistory";
import { RemoteOperations } from "@/components/RemoteOperations";
import { FileStatus, RepositoryInfo } from "@/services/gitService";

interface GitToolsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repoPath: string;
  repoInfo: RepositoryInfo;
  refreshSeed: number;
  onOpenSave: () => void;
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
  "default" | "secondary" | "destructive" | "outline" | "muted"
> = {
  modified: "secondary",
  added: "default",
  deleted: "destructive",
  renamed: "secondary",
  untracked: "outline",
  unknown: "muted",
};

export function GitToolsDialog({
  open,
  onOpenChange,
  repoPath,
  repoInfo,
  refreshSeed,
  onOpenSave,
}: GitToolsDialogProps) {
  const changeCount = repoInfo.status_files.length;
  const hasChanges = changeCount > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>Git tools</DialogTitle>
          <DialogDescription>
            Keep these tucked away until you need them.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-6">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <div>
                  <CardTitle>Change radar</CardTitle>
                  <CardDescription>
                    {hasChanges
                      ? `${changeCount} file${changeCount === 1 ? "" : "s"} need attention.`
                      : "Working tree is clean."}
                  </CardDescription>
                </div>
                <Button
                  onClick={() => {
                    onOpenChange(false);
                    onOpenSave();
                  }}
                  disabled={!hasChanges}
                >
                  Save & push
                </Button>
              </CardHeader>
              <CardContent>
                {!hasChanges ? (
                  <div className="rounded-lg border-2 border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
                    Nothing to stage or commit.
                  </div>
                ) : (
                  <div className="max-h-72 space-y-2 overflow-y-auto pr-2">
                    {repoInfo.status_files.map((file) => (
                      <div
                        key={file.path}
                        className="flex items-center gap-3 rounded-lg border-2 border-border bg-card/80 px-3 py-2 shadow-[var(--shadow-xs)]"
                      >
                        <Badge variant={statusVariant[file.status]}>
                          {statusLabel[file.status]}
                        </Badge>
                        <span className="truncate text-xs font-mono text-foreground/80">
                          {file.path}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <CommitHistory key={`history-${refreshSeed}`} repoPath={repoPath} />
          </div>

          <div className="space-y-6">
            <RemoteOperations
              key={`remotes-${refreshSeed}`}
              repoPath={repoPath}
              currentBranch={repoInfo.head_branch}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
