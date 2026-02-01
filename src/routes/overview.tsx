import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { BranchSwitcher } from "@/components/BranchSwitcher";
import { GitToolsDialog } from "@/components/GitToolsDialog";
import { SaveChangesDialog } from "@/components/SaveChangesDialog";
import { AIChat } from "@/components/AIChat";
import { FalckDashboard } from "@/components/falck/FalckDashboard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { gitService, RepositoryInfo } from "@/services/gitService";
import { useAppState } from "@/router/app-state";
import { ArrowLeft } from "lucide-react";

export const Route = createFileRoute("/overview")({
  component: OverviewRoute,
});

function OverviewRoute() {
  const navigate = Route.useNavigate();
  const { sshKey, repoPath, setRepoPath } = useAppState();
  const [repoInfo, setRepoInfo] = useState<RepositoryInfo | null>(null);
  const [refreshSeed, setRefreshSeed] = useState(0);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [showGitTools, setShowGitTools] = useState(false);
  const [pullLoading, setPullLoading] = useState(false);
  const [pullError, setPullError] = useState<string | null>(null);

  const loadRepoInfo = async (path: string) => {
    try {
      const info = await gitService.getRepositoryInfo(path);
      setRepoInfo(info);
    } catch (err) {
      console.error("Failed to load repo info:", err);
    }
  };

  useEffect(() => {
    if (!repoPath) {
      setRepoInfo(null);
      return;
    }
    setPullError(null);
    void loadRepoInfo(repoPath);
  }, [repoPath]);

  const handleRefresh = async () => {
    if (!repoPath) {
      return;
    }
    setRefreshSeed((prev) => prev + 1);
    await loadRepoInfo(repoPath);
  };

  const handleCloseRepo = () => {
    setRepoPath(null);
    setRepoInfo(null);
    setShowSaveDialog(false);
    setShowGitTools(false);
    setPullError(null);
    navigate({ to: "/repo" });
  };

  const handlePull = async () => {
    if (!repoPath || !repoInfo) return;
    setPullError(null);
    setPullLoading(true);
    try {
      const remotes = await gitService.getRemotes(repoPath);
      const remote = remotes.includes("origin") ? "origin" : remotes[0];
      if (!remote) {
        setPullError("No remotes configured.");
        return;
      }
      await gitService.pull(repoPath, remote, repoInfo.head_branch);
      await loadRepoInfo(repoPath);
    } catch (err) {
      setPullError(String(err));
    } finally {
      setPullLoading(false);
    }
  };

  const handleDragStart = () => {
    getCurrentWindow()
      .startDragging()
      .catch(() => {
        // no-op outside Tauri runtime
      });
  };

  if (!sshKey) {
    return <Navigate to="/ssh" />;
  }

  if (!repoPath) {
    return <Navigate to="/repo" />;
  }

  if (!repoInfo) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        Loading repository...
      </div>
    );
  }

  const hasChanges = repoInfo.is_dirty;
  const changeCount = repoInfo.status_files.length;
  const repoName =
    repoPath
      ?.replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .pop() ?? "Repository";

  return (
    <div className="relative min-h-screen bg-background text-foreground">
      <header className="relative z-10 bg-card/80 backdrop-blur">
        <div className="mx-auto w-full max-w-7xl px-6 py-4">
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div
                className="flex flex-wrap items-center gap-3"
                data-tauri-drag-region="false"
              >
                <Button variant="ghost" size="sm" onClick={handleCloseRepo}>
                  <ArrowLeft className="h-4 w-4" />
                  <span>Back</span>
                </Button>
                <div className="min-w-[220px]">
                  <p className="text-sm font-semibold uppercase tracking-[0.32em] text-foreground/80">
                    {repoName}
                  </p>
                  <p className="text-xs font-mono text-muted-foreground break-all">
                    {repoPath}
                  </p>
                </div>
              </div>
              <div
                className="flex flex-wrap items-center gap-3"
                data-tauri-drag-region="false"
              >
                <Badge
                  variant={hasChanges ? "destructive" : "secondary"}
                  className="gap-2 px-3 py-1"
                >
                  <span
                    className={`h-2.5 w-2.5 rounded-full ${
                      hasChanges
                        ? "bg-destructive-foreground"
                        : "bg-muted-foreground"
                    }`}
                  />
                  {hasChanges
                    ? `${changeCount} unsaved ${changeCount === 1 ? "change" : "changes"}`
                    : "All changes saved"}
                </Badge>
                <Button
                  onClick={() => setShowSaveDialog(true)}
                  disabled={!hasChanges}
                  size="lg"
                  className="min-w-[170px] shadow-[var(--shadow-lg)]"
                >
                  Save
                </Button>
              </div>
            </div>

            <div
              className="flex flex-wrap items-center gap-3"
              data-tauri-drag-region="false"
            >
              <div className="min-w-[220px]">
                <BranchSwitcher
                  repoPath={repoPath}
                  branches={repoInfo.branches}
                  currentBranch={repoInfo.head_branch}
                  onBranchChange={handleRefresh}
                  compact
                />
              </div>
              <Button
                variant="outline"
                onClick={handlePull}
                disabled={pullLoading}
                size="sm"
              >
                {pullLoading ? "Syncing..." : "Sync"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowGitTools(true)}
              >
                Git tools
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigate({ to: "/settings" })}
              >
                Settings
              </Button>
              <Button variant="ghost" size="sm" onClick={handleRefresh}>
                Refresh
              </Button>
            </div>
          </div>
        </div>
        {pullError && (
          <div className="mx-auto w-full max-w-7xl px-6 pb-2">
            <p className="text-sm text-destructive">{pullError}</p>
          </div>
        )}
      </header>

      <main className="relative z-10 mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 px-6 pb-12">
        <section
          className="space-y-6 animate-in fade-in slide-in-from-bottom-4"
          style={{ animationDuration: "700ms" }}
        >
          <FalckDashboard repoPath={repoPath} />
        </section>
        <section
          className="space-y-6 animate-in fade-in slide-in-from-bottom-4"
          style={{ animationDuration: "800ms" }}
        >
          <AIChat repoPath={repoPath} />
        </section>
      </main>

      <SaveChangesDialog
        open={showSaveDialog}
        onOpenChange={setShowSaveDialog}
        repoPath={repoPath}
        currentBranch={repoInfo.head_branch}
        onSaved={handleRefresh}
      />
      <GitToolsDialog
        open={showGitTools}
        onOpenChange={setShowGitTools}
        repoPath={repoPath}
        repoInfo={repoInfo}
        refreshSeed={refreshSeed}
        onOpenSave={() => setShowSaveDialog(true)}
      />
    </div>
  );
}
