import { useState } from "react";
import { BranchManager } from "@/components/BranchManager";
import { CommitHistory } from "@/components/CommitHistory";
import { RemoteOperations } from "@/components/RemoteOperations";
import { RepoSelector } from "@/components/RepoSelector";
import { StagingArea } from "@/components/StagingArea";
import { AIChat } from "@/components/AIChat";
import { OpenCodeSettings } from "@/components/OpenCodeSettings";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { gitService, RepositoryInfo } from "@/services/gitService";
import logo from "@/assets/logo.png";

function App() {
  const [repoPath, setRepoPath] = useState<string | null>(null);
  const [repoInfo, setRepoInfo] = useState<RepositoryInfo | null>(null);
  const [refreshSeed, setRefreshSeed] = useState(0);
  const [activeTab, setActiveTab] = useState<"git" | "ai">("git");
  const [showSettings, setShowSettings] = useState(false);

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

  if (!repoPath || !repoInfo) {
    return <RepoSelector onRepoSelect={handleRepoSelect} />;
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <header
        className="relative border-b-2 border-border bg-card/90"
        data-tauri-drag-region
      >
        <div className="absolute inset-x-0 top-0 h-2 bg-primary" />
        <div className="mx-auto flex max-w-6xl flex-col gap-6 pr-6 pl-16 py-6 md:flex-row md:items-center md:justify-between">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 items-center justify-center border-2 border-border bg-primary shadow-[var(--shadow-sm)]">
              <img src={logo} alt="Falck logo" className="h-7 w-7 object-contain" />
            </div>
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-[0.4em] text-foreground">
                Falck
              </p>
              <h1 className="text-2xl font-black uppercase tracking-tight md:text-3xl">
                Repository dashboard
              </h1>
              <p className="text-xs font-mono text-muted-foreground">{repoPath}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2" data-tauri-drag-region="false">
            <Badge variant={repoInfo.is_dirty ? "destructive" : "secondary"}>
              {repoInfo.is_dirty ? "Uncommitted changes" : "Working tree clean"}
            </Badge>
            <Button variant="outline" size="sm" onClick={() => setShowSettings(true)}>
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
              }}
            >
              Close repo
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-1 flex-col px-6 py-10">
        <Tabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as "git" | "ai")}
          className="flex-1"
        >
          <TabsList className="w-full justify-start gap-2">
            <TabsTrigger value="git">Git operations</TabsTrigger>
            <TabsTrigger value="ai">AI coding</TabsTrigger>
          </TabsList>

          <TabsContent value="git" className="mt-6">
            <div className="grid gap-6 lg:grid-cols-2">
              <div className="space-y-6">
                <BranchManager
                  key={`branches-${refreshSeed}`}
                  repoPath={repoPath}
                  onBranchChange={handleRefresh}
                />
                <RemoteOperations
                  repoPath={repoPath}
                  currentBranch={repoInfo.head_branch}
                />
              </div>
              <div className="space-y-6">
                <StagingArea
                  key={`staging-${refreshSeed}`}
                  repoPath={repoPath}
                  onCommit={handleRefresh}
                />
                <CommitHistory key={`history-${refreshSeed}`} repoPath={repoPath} />
              </div>
            </div>
          </TabsContent>

          <TabsContent value="ai" className="mt-6">
            <AIChat repoPath={repoPath} />
          </TabsContent>
        </Tabs>
      </main>

      <OpenCodeSettings open={showSettings} onOpenChange={setShowSettings} />
    </div>
  );
}

export default App;
