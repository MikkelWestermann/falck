import { useState } from "react";
import { BranchSwitcher } from "@/components/BranchSwitcher";
import { GitToolsDialog } from "@/components/GitToolsDialog";
import { RepoSelector } from "@/components/RepoSelector";
import { SaveChangesDialog } from "@/components/SaveChangesDialog";
import { AIChat } from "@/components/AIChat";
import { OpenCodeSettings } from "@/components/OpenCodeSettings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { gitService, RepositoryInfo } from "@/services/gitService";
import logo from "@/assets/logo.png";

function App() {
  const [repoPath, setRepoPath] = useState<string | null>(null);
  const [repoInfo, setRepoInfo] = useState<RepositoryInfo | null>(null);
  const [refreshSeed, setRefreshSeed] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [showGitTools, setShowGitTools] = useState(false);

  const loadRepoInfo = async (path: string) => {
    try {
      const info = await gitService.getRepositoryInfo(path);
      setRepoInfo(info);
    } catch (err) {
      console.error("Failed to load repo info:", err);
    }
  };

  const handleRepoSelect = async (path: string) => {
    setRepoPath(path);
    await loadRepoInfo(path);
  };

  const handleRefresh = async () => {
    if (!repoPath) {
      return;
    }
    setRefreshSeed((prev) => prev + 1);
    await loadRepoInfo(repoPath);
  };

  const handleDragStart = () => {
    getCurrentWindow()
      .startDragging()
      .catch(() => {
        // no-op outside Tauri runtime
      });
  };

  if (!repoPath || !repoInfo) {
    return <RepoSelector onRepoSelect={handleRepoSelect} />;
  }

  const hasChanges = repoInfo.is_dirty;
  const changeCount = repoInfo.status_files.length;

  return (
    <div className="relative min-h-screen bg-background text-foreground">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-24 right-0 h-72 w-72 rounded-full bg-secondary/25 blur-3xl" />
        <div className="absolute left-[-80px] top-40 h-72 w-72 rounded-full bg-primary/20 blur-3xl" />
        <div className="absolute inset-x-0 top-28 h-px bg-gradient-to-r from-transparent via-border to-transparent opacity-60" />
      </div>
      <header
        className="relative z-10 border-b-2 border-border/80 bg-card/80 backdrop-blur"
      >
        <div
          className="absolute inset-x-0 top-0 z-20 h-10 cursor-grab bg-gradient-to-b from-foreground/10 to-transparent"
          data-tauri-drag-region
          onPointerDown={handleDragStart}
        />
        <div className="mx-auto w-full max-w-7xl px-6 pb-8 pt-12">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-start gap-4">
              <div className="flex h-12 w-12 items-center justify-center border-2 border-border bg-card shadow-[var(--shadow-md)]">
                <img src={logo} alt="Falck logo" className="h-7 w-7 object-contain" />
              </div>
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-[0.4em] text-muted-foreground">
                  Falck
                </p>
                <h1 className="text-3xl font-black uppercase tracking-tight">
                  AI coding deck
                </h1>
                <p className="text-xs font-mono text-muted-foreground">
                  {repoPath}
                </p>
              </div>
            </div>
            <div
              className="flex flex-wrap items-center gap-2"
              data-tauri-drag-region="false"
            >
              <Badge variant={hasChanges ? "destructive" : "secondary"}>
                {hasChanges
                  ? `${changeCount} unsaved ${changeCount === 1 ? "change" : "changes"}`
                  : "All changes saved"}
              </Badge>
              <Button
                onClick={() => setShowSaveDialog(true)}
                disabled={!hasChanges}
                className="shadow-[var(--shadow-lg)]"
              >
                Save &amp; push
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowGitTools(true)}
              >
                Git tools
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowSettings(true)}
              >
                AI settings
              </Button>
              <Button variant="outline" size="sm" onClick={handleRefresh}>
                Refresh
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                setRepoPath(null);
                setRepoInfo(null);
                setShowSaveDialog(false);
                setShowGitTools(false);
              }}
            >
              Close repo
            </Button>
            </div>
          </div>

          <div
            className="mt-6 flex flex-col gap-4 rounded-lg border-2 border-border bg-card/80 p-4 shadow-[var(--shadow-md)] md:flex-row md:items-center md:justify-between"
            data-tauri-drag-region="false"
          >
            <div className="min-w-[220px]">
              <BranchSwitcher
                repoPath={repoPath}
                branches={repoInfo.branches}
                currentBranch={repoInfo.head_branch}
                onBranchChange={handleRefresh}
              />
            </div>
            <div className="text-sm text-muted-foreground">
              Focus on AI-assisted coding. Git tools stay in the side lane.
            </div>
          </div>
        </div>
      </header>

      <main className="relative z-10 mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 px-6 pb-12">
        <section
          className="space-y-6 animate-in fade-in slide-in-from-bottom-4"
          style={{ animationDuration: "700ms" }}
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

      <OpenCodeSettings open={showSettings} onOpenChange={setShowSettings} />
    </div>
  );
}

export default App;
