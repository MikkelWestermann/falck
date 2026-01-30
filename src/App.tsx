import { useState } from "react";
import "./App.css";
import { BranchManager } from "./components/BranchManager";
import { CommitHistory } from "./components/CommitHistory";
import { RemoteOperations } from "./components/RemoteOperations";
import { RepoSelector } from "./components/RepoSelector";
import { StagingArea } from "./components/StagingArea";
import { gitService, RepositoryInfo } from "./services/gitService";

function App() {
  const [repoPath, setRepoPath] = useState<string | null>(null);
  const [repoInfo, setRepoInfo] = useState<RepositoryInfo | null>(null);
  const [refreshSeed, setRefreshSeed] = useState(0);

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
    <div className="app">
      <header className="app-header">
        <div>
          <p className="eyebrow">Falck</p>
          <h1>Repository dashboard</h1>
          <p className="lede small">{repoPath}</p>
        </div>
        <div className="header-actions">
          <div className={`status-dot ${repoInfo.is_dirty ? "dirty" : "clean"}`}>
            {repoInfo.is_dirty ? "Uncommitted changes" : "Working tree clean"}
          </div>
          <button className="btn ghost" onClick={handleRefresh}>
            Refresh
          </button>
          <button
            className="btn danger"
            onClick={() => {
              setRepoPath(null);
              setRepoInfo(null);
            }}
          >
            Close repo
          </button>
        </div>
      </header>

      <main className="app-main">
        <div className="grid">
          <div className="column">
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
          <div className="column">
            <StagingArea
              key={`staging-${refreshSeed}`}
              repoPath={repoPath}
              onCommit={handleRefresh}
            />
            <CommitHistory key={`history-${refreshSeed}`} repoPath={repoPath} />
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;
