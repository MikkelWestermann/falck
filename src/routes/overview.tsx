import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { BranchSwitcher } from "@/components/BranchSwitcher";
import { CommitHistory } from "@/components/CommitHistory";
import { SaveChangesDialog } from "@/components/SaveChangesDialog";
import { UnsavedChangesDialog } from "@/components/UnsavedChangesDialog";
import { AIChat } from "@/components/AIChat";
import { FalckDashboard } from "@/components/falck/FalckDashboard";
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
import { getCurrentWindow } from "@tauri-apps/api/window";
import { gitService, RepositoryInfo } from "@/services/gitService";
import { falckService } from "@/services/falckService";
import { useAppState } from "@/router/app-state";
import { ArrowLeft, History, RefreshCcw } from "lucide-react";

export const Route = createFileRoute("/overview")({
  component: OverviewRoute,
});

function OverviewRoute() {
  const navigate = Route.useNavigate();
  const { sshKey, repoPath, setRepoPath } = useAppState();
  const [repoInfo, setRepoInfo] = useState<RepositoryInfo | null>(null);
  const [refreshSeed, setRefreshSeed] = useState(0);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);
  const [showDiscardConfirmDialog, setShowDiscardConfirmDialog] =
    useState(false);
  const [showVersionHistoryDialog, setShowVersionHistoryDialog] =
    useState(false);
  const [pullLoading, setPullLoading] = useState(false);
  const [pullError, setPullError] = useState<string | null>(null);
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null);
  const [protectDefaultBranch, setProtectDefaultBranch] = useState(false);
  const [pendingProjectAction, setPendingProjectAction] = useState<{
    type: "switch" | "create";
    projectName: string;
  } | null>(null);

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

  useEffect(() => {
    if (!repoPath) {
      setDefaultBranch(null);
      setProtectDefaultBranch(false);
      return;
    }

    let active = true;
    const loadFalckConfig = async () => {
      try {
        const config = await falckService.loadConfig(repoPath);
        if (!active) return;
        setDefaultBranch(config.repository?.default_branch ?? null);
        setProtectDefaultBranch(
          Boolean(config.repository?.protect_default_branch),
        );
      } catch {
        if (!active) return;
        setDefaultBranch(null);
        setProtectDefaultBranch(false);
      }
    };

    void loadFalckConfig();
    return () => {
      active = false;
    };
  }, [repoPath]);

  useEffect(() => {
    if (!repoPath) {
      return;
    }
    const interval = setInterval(() => {
      void loadRepoInfo(repoPath);
    }, 5000);
    return () => clearInterval(interval);
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
    setShowUnsavedDialog(false);
    setShowDiscardConfirmDialog(false);
    setPendingProjectAction(null);
    setPullError(null);
    navigate({ to: "/repo" });
  };

  const handleConfirmDiscard = async () => {
    if (!repoPath) return;
    try {
      await gitService.discardChanges(repoPath);
      setShowDiscardConfirmDialog(false);
      await handleRefresh();
    } catch (err) {
      console.error("Failed to discard changes:", err);
    }
  };

  const handlePull = async () => {
    if (!repoPath || !repoInfo) return;
    setPullError(null);
    setPullLoading(true);
    try {
      const remotes = await gitService.getRemotes(repoPath);
      const remote = remotes.includes("origin") ? "origin" : remotes[0];
      if (!remote) {
        setPullError("No sync destination configured.");
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

  const resolvedDefaultBranch = useMemo(() => {
    if (defaultBranch) {
      return defaultBranch;
    }
    if (!repoInfo) {
      return null;
    }
    const branchNames = repoInfo.branches.map((branch) => branch.name);
    if (branchNames.includes("main")) {
      return "main";
    }
    if (branchNames.includes("master")) {
      return "master";
    }
    return repoInfo.head_branch;
  }, [defaultBranch, repoInfo]);

  const saveBlockedReason =
    protectDefaultBranch && resolvedDefaultBranch === repoInfo?.head_branch
      ? "Saving is disabled on the default project. Switch to another project to save."
      : null;

  const performProjectSwitch = async (projectName: string) => {
    if (!repoPath) return;
    await gitService.checkoutBranch(repoPath, projectName);
    await loadRepoInfo(repoPath);
  };

  const performProjectCreate = async (projectName: string) => {
    if (!repoPath || !repoInfo) return;
    const baseBranch = resolvedDefaultBranch ?? repoInfo.head_branch;
    await gitService.checkoutBranch(repoPath, baseBranch);

    const remotes = await gitService.getRemotes(repoPath);
    const remote = remotes.includes("origin") ? "origin" : remotes[0];
    if (remote) {
      await gitService.pull(repoPath, remote, baseBranch);
    }

    await gitService.createBranch(repoPath, projectName);
    await gitService.checkoutBranch(repoPath, projectName);
    await loadRepoInfo(repoPath);
  };

  const queueProjectAction = async (action: {
    type: "switch" | "create";
    projectName: string;
  }) => {
    if (repoInfo?.is_dirty) {
      setPendingProjectAction(action);
      setShowUnsavedDialog(true);
      return;
    }
    if (action.type === "switch") {
      await performProjectSwitch(action.projectName);
      return;
    }
    await performProjectCreate(action.projectName);
  };

  const handleSelectProject = async (projectName: string) => {
    await queueProjectAction({ type: "switch", projectName });
  };

  const handleCreateProject = async (projectName: string) => {
    await queueProjectAction({ type: "create", projectName });
  };

  const handleDiscardAndContinue = async () => {
    if (!repoPath || !pendingProjectAction) {
      setShowUnsavedDialog(false);
      return;
    }
    try {
      await gitService.discardChanges(repoPath);
      setShowUnsavedDialog(false);
      if (pendingProjectAction.type === "switch") {
        await performProjectSwitch(pendingProjectAction.projectName);
      } else {
        await performProjectCreate(pendingProjectAction.projectName);
      }
    } finally {
      setPendingProjectAction(null);
    }
  };

  const handleSaveAndContinue = () => {
    setShowUnsavedDialog(false);
    setShowSaveDialog(true);
  };

  const handleSaveComplete = async () => {
    const action = pendingProjectAction;
    if (action) {
      setPendingProjectAction(null);
    }
    await handleRefresh();
    if (!action) {
      return;
    }
    if (action.type === "switch") {
      await performProjectSwitch(action.projectName);
      return;
    }
    await performProjectCreate(action.projectName);
  };

  const handleSaveDialogOpenChange = (open: boolean) => {
    setShowSaveDialog(open);
    if (!open && pendingProjectAction) {
      setPendingProjectAction(null);
    }
  };

  const handleUnsavedDialogOpenChange = (open: boolean) => {
    setShowUnsavedDialog(open);
    if (!open) {
      setPendingProjectAction(null);
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
      <div className="flex min-h-screen items-center justify-center bg-page-background text-sm text-muted-foreground">
        Loading repository...
      </div>
    );
  }

  const hasChanges = repoInfo.is_dirty;
  const changeCount = repoInfo.status_files.length;
  const saveBlocked = Boolean(saveBlockedReason);
  const repoName =
    repoPath
      ?.replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .pop() ?? "Repository";

  return (
    <div className="relative min-h-screen text-foreground">
      <header className="relative z-10 backdrop-blur">
        <div className="mx-auto w-full max-w-7xl px-6 pb-4">
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
                {hasChanges ? (
                  <Button
                    variant="destructive"
                    size="sm"
                    className="h-auto cursor-pointer gap-2 l px-3 py-1 font-normal"
                    onClick={() => setShowDiscardConfirmDialog(true)}
                  >
                    <span className="h-2.5 w-2.5 rounded-full bg-destructive-foreground" />
                    {`${changeCount} unsaved ${changeCount === 1 ? "change" : "changes"}`}
                  </Button>
                ) : (
                  <Badge variant="secondary" className="gap-2 px-3 py-1">
                    <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground" />
                    All changes saved
                  </Badge>
                )}
                <Button
                  onClick={() => setShowSaveDialog(true)}
                  disabled={!hasChanges || saveBlocked}
                  size="lg"
                  className="min-w-[170px] shadow-[var(--shadow-lg)]"
                >
                  Save
                </Button>
              </div>
            </div>

            <div
              className="flex flex-wrap items-center justify-between gap-3"
              data-tauri-drag-region="false"
            >
              <div className="flex items-center gap-1">
                <div className="min-w-[220px]">
                  <BranchSwitcher
                    branches={repoInfo.branches}
                    currentBranch={repoInfo.head_branch}
                    onSelectProject={handleSelectProject}
                    onCreateProject={handleCreateProject}
                    compact
                  />
                </div>
                <Button
                  variant="ghost"
                  onClick={handlePull}
                  disabled={pullLoading}
                  size="sm"
                >
                  <RefreshCcw className="h-4 w-4" />
                </Button>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowVersionHistoryDialog(true)}
              >
                <History className="h-4 w-4" />
                Version history
              </Button>
              {/* <Button
                variant="ghost"
                size="sm"
                onClick={() => navigate({ to: "/settings" })}
              >
                Settings
              </Button>
              <Button variant="ghost" size="sm" onClick={handleRefresh}>
                Refresh
              </Button> */}
            </div>
          </div>
        </div>
        {pullError && (
          <div className="mx-auto w-full max-w-7xl px-6 pb-2">
            <p className="text-sm text-destructive">{pullError}</p>
          </div>
        )}
      </header>

      <main className="relative z-10 mx-auto w-full max-w-7xl flex-1 px-6 pb-12">
        <div className="gap-6">
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
        </div>
      </main>

      <SaveChangesDialog
        open={showSaveDialog}
        onOpenChange={handleSaveDialogOpenChange}
        repoPath={repoPath}
        currentBranch={repoInfo.head_branch}
        defaultBranch={resolvedDefaultBranch ?? undefined}
        protectDefaultBranch={protectDefaultBranch}
        onSaved={handleSaveComplete}
      />
      <UnsavedChangesDialog
        open={showUnsavedDialog}
        onOpenChange={handleUnsavedDialogOpenChange}
        onSave={handleSaveAndContinue}
        onDiscard={handleDiscardAndContinue}
        targetLabel={
          pendingProjectAction?.type === "create"
            ? `create the "${pendingProjectAction.projectName}" project`
            : pendingProjectAction
              ? `switch to "${pendingProjectAction.projectName}"`
              : undefined
        }
        saveDisabled={saveBlocked}
        saveDisabledReason={
          saveBlocked ? (saveBlockedReason ?? undefined) : undefined
        }
      />
      <Dialog
        open={showDiscardConfirmDialog}
        onOpenChange={setShowDiscardConfirmDialog}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard changes?</DialogTitle>
            <DialogDescription>
              This will permanently discard all unsaved changes. This cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setShowDiscardConfirmDialog(false)}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleConfirmDiscard}>
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={showVersionHistoryDialog}
        onOpenChange={setShowVersionHistoryDialog}
      >
        <DialogContent>
          <DialogTitle>Version history</DialogTitle>
          <DialogDescription>Messed up? Go back in time</DialogDescription>
          <CommitHistory
            repoPath={repoPath}
            baseBranch={resolvedDefaultBranch ?? repoInfo.head_branch}
            currentBranch={repoInfo.head_branch}
            hasUnsavedChanges={repoInfo.is_dirty}
            onRestored={() => {
              handleRefresh();
              setShowVersionHistoryDialog(false);
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
