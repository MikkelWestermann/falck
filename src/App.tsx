import { useEffect, useState } from "react";
import { BranchSwitcher } from "@/components/BranchSwitcher";
import { GitToolsDialog } from "@/components/GitToolsDialog";
import { RepoSelector } from "@/components/RepoSelector";
import { SaveChangesDialog } from "@/components/SaveChangesDialog";
import { AIChat } from "@/components/AIChat";
import { SSHKeySetup } from "@/components/ssh/SSHKeySetup";
import { SettingsPage } from "@/components/SettingsPage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarTrigger,
} from "@/components/ui/menubar";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { gitService, RepositoryInfo } from "@/services/gitService";
import { configService } from "@/services/configService";
import { SSHKey, sshService } from "@/services/sshService";

function App() {
  const [repoPath, setRepoPath] = useState<string | null>(null);
  const [repoInfo, setRepoInfo] = useState<RepositoryInfo | null>(null);
  const [refreshSeed, setRefreshSeed] = useState(0);
  const [showSettingsPage, setShowSettingsPage] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [showGitTools, setShowGitTools] = useState(false);
  const [showSSHSettings, setShowSSHSettings] = useState(false);
  const [sshKey, setSshKey] = useState<SSHKey | null>(() =>
    configService.getSelectedSSHKey(),
  );
  const [sshReady, setSshReady] = useState(false);

  useEffect(() => {
    const verifyKey = async () => {
      const stored = configService.getSelectedSSHKey();
      if (!stored) {
        setSshReady(true);
        return;
      }

      try {
        const keys = await sshService.listKeys();
        const match =
          keys.find(
            (key) =>
              key.private_key_path === stored.private_key_path ||
              key.fingerprint === stored.fingerprint,
          ) || null;
        if (match) {
          setSshKey(match);
        } else {
          configService.setSelectedSSHKey(null);
          setSshKey(null);
        }
      } catch {
        setSshKey(stored);
      } finally {
        setSshReady(true);
      }
    };

    void verifyKey();
  }, []);

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

  const handleCloseRepo = () => {
    setRepoPath(null);
    setRepoInfo(null);
    setShowSaveDialog(false);
    setShowGitTools(false);
    setShowSettingsPage(false);
    setShowSSHSettings(false);
  };

  const handleDragStart = () => {
    getCurrentWindow()
      .startDragging()
      .catch(() => {
        // no-op outside Tauri runtime
      });
  };

  if (!sshReady) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        Loading SSH configuration…
      </div>
    );
  }

  if (!sshKey) {
    return <SSHKeySetup onConfigured={setSshKey} />;
  }

  if (showSSHSettings && sshKey) {
    return (
      <SSHKeySetup
        mode="manage"
        initialKey={sshKey}
        onConfigured={setSshKey}
        onClose={() => setShowSSHSettings(false)}
      />
    );
  }

  if (showSettingsPage && sshKey) {
    return (
      <SettingsPage
        sshKey={sshKey}
        onManageSSHKey={() => setShowSSHSettings(true)}
        onClose={() => setShowSettingsPage(false)}
      />
    );
  }

  if (!repoPath || !repoInfo) {
    return (
      <RepoSelector
        onRepoSelect={handleRepoSelect}
        onOpenSettings={() => setShowSettingsPage(true)}
      />
    );
  }

  const hasChanges = repoInfo.is_dirty;
  const changeCount = repoInfo.status_files.length;
  const repoName =
    repoPath
      ?.replace(/[/\\\\]+$/, "")
      .split(/[/\\\\]/)
      .pop() ?? "Repository";

  return (
    <div className="relative min-h-screen bg-background text-foreground">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-24 right-0 h-72 w-72 rounded-full bg-secondary/25 blur-3xl" />
        <div className="absolute left-[-80px] top-40 h-72 w-72 rounded-full bg-primary/20 blur-3xl" />
        <div className="absolute inset-x-0 top-28 h-px bg-gradient-to-r from-transparent via-border to-transparent opacity-60" />
      </div>
      <header className="relative z-10 bg-card/80 backdrop-blur">
        <div
          className="absolute inset-x-0 top-0 z-20 h-8 cursor-grab bg-gradient-to-b from-foreground/10 to-transparent"
          data-tauri-drag-region
          onPointerDown={handleDragStart}
        />
        <div className="mx-auto w-full max-w-7xl px-6 py-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div
              className="flex flex-wrap items-center gap-4"
              data-tauri-drag-region="false"
            >
              <div className="min-w-[220px]">
                <p className="text-sm font-semibold uppercase tracking-[0.32em] text-foreground/80">
                  {repoName}
                </p>
                <p className="text-xs font-mono text-muted-foreground break-all">
                  {repoPath}
                </p>
              </div>
              <Menubar className="bg-card/70">
                <MenubarMenu>
                  <MenubarTrigger>Repo</MenubarTrigger>
                  <MenubarContent align="start">
                    <MenubarItem onSelect={handleRefresh}>Refresh</MenubarItem>
                    <MenubarSeparator />
                    <MenubarItem
                      onSelect={handleCloseRepo}
                      className="text-destructive focus:text-destructive"
                    >
                      Close repo
                    </MenubarItem>
                  </MenubarContent>
                </MenubarMenu>
                <MenubarMenu>
                  <MenubarTrigger>Git</MenubarTrigger>
                  <MenubarContent align="start">
                    <MenubarItem onSelect={() => setShowGitTools(true)}>
                      Git tools
                    </MenubarItem>
                    <MenubarItem
                      onSelect={() => setShowSaveDialog(true)}
                      disabled={!hasChanges}
                    >
                      Save &amp; push
                    </MenubarItem>
                  </MenubarContent>
                </MenubarMenu>
                <MenubarMenu>
                  <MenubarTrigger>Settings</MenubarTrigger>
                  <MenubarContent align="start">
                    <MenubarItem onSelect={() => setShowSettingsPage(true)}>
                      Open settings
                    </MenubarItem>
                  </MenubarContent>
                </MenubarMenu>
              </Menubar>
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
                Save &amp; push
              </Button>
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
    </div>
  );
}

export default App;
