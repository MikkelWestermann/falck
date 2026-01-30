import { useState } from "react";
import { gitService } from "../services/gitService";

interface RepoSelectorProps {
  onRepoSelect: (path: string) => void;
}

export function RepoSelector({ onRepoSelect }: RepoSelectorProps) {
  const [cloneUrl, setCloneUrl] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleClone = async () => {
    if (!cloneUrl || !localPath) {
      setError("Add a URL and a local folder to clone into.");
      return;
    }

    setLoading(true);
    setError("");
    try {
      await gitService.cloneRepository(cloneUrl, localPath);
      onRepoSelect(localPath);
      setCloneUrl("");
      setLocalPath("");
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleOpenExisting = async () => {
    if (!repoPath) {
      setError("Enter an existing repository path.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await gitService.getRepositoryInfo(repoPath);
      onRepoSelect(repoPath);
    } catch (err) {
      setError("That folder does not look like a Git repository.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="repo-shell">
      <div className="repo-hero">
        <div>
          <p className="eyebrow">GitGUI</p>
          <h1>Ship commits with calm.</h1>
          <p className="lede">
            Clone a new repo or open an existing one to see history, stage files,
            and push updates.
          </p>
        </div>
        <div className="repo-meta">
          <div className="meta-chip">Tauri + React</div>
          <div className="meta-chip">Local-first</div>
          <div className="meta-chip">No CLI required</div>
        </div>
      </div>

      <div className="repo-panels">
        <section className="panel">
          <header className="panel-header">
            <h2>Clone repository</h2>
            <p>Start from a remote URL and a local folder.</p>
          </header>
          <div className="field">
            <label>Repository URL</label>
            <input
              type="text"
              placeholder="https://github.com/user/repo.git"
              value={cloneUrl}
              onChange={(e) => setCloneUrl(e.target.value)}
            />
          </div>
          <div className="field">
            <label>Local path</label>
            <input
              type="text"
              placeholder="/Users/you/dev/repo"
              value={localPath}
              onChange={(e) => setLocalPath(e.target.value)}
            />
          </div>
          <button
            className="btn primary"
            onClick={handleClone}
            disabled={loading}
          >
            {loading ? "Cloning…" : "Clone"}
          </button>
        </section>

        <section className="panel">
          <header className="panel-header">
            <h2>Open existing</h2>
            <p>Point GitGUI at a folder already on your disk.</p>
          </header>
          <div className="field">
            <label>Repository path</label>
            <input
              type="text"
              placeholder="/Users/you/dev/project"
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
            />
          </div>
          <button
            className="btn ghost"
            onClick={handleOpenExisting}
            disabled={loading}
          >
            {loading ? "Opening…" : "Open repo"}
          </button>
        </section>
      </div>

      {error && <div className="notice error">{error}</div>}
    </div>
  );
}
