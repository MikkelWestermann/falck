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
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b bg-card/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-6 md:flex-row md:items-center md:justify-between">
          <div className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-[0.35em] text-primary/80">
              Falck
            </p>
            <h1 className="text-2xl font-semibold md:text-3xl">
              Repository dashboard
            </h1>
            <p className="text-sm text-muted-foreground">{repoPath}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant={repoInfo.is_dirty ? "destructive" : "secondary"}
              className="rounded-full"
            >
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

      <main className="mx-auto flex max-w-6xl flex-1 flex-col px-6 py-8">
        <Tabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as "git" | "ai")}
          className="flex-1"
        >
          <TabsList className="w-full justify-start gap-2 rounded-full bg-secondary/70 p-1">
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
