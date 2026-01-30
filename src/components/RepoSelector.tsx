import { useEffect, useState } from "react";
import { gitService } from "../services/gitService";

interface RepoSelectorProps {
  onRepoSelect: (path: string) => void;
}

export function RepoSelector({ onRepoSelect }: RepoSelectorProps) {
  const [cloneUrl, setCloneUrl] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [cloneName, setCloneName] = useState("");
  const [repoName, setRepoName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [savedRepos, setSavedRepos] = useState<
    Awaited<ReturnType<typeof gitService.listSavedRepos>>
  >([]);

  useEffect(() => {
    void loadSavedRepos();
  }, []);

  const loadSavedRepos = async () => {
    try {
      const repos = await gitService.listSavedRepos();
      setSavedRepos(repos);
    } catch (err) {
      console.error("Failed to load saved repos:", err);
    }
  };

  const handleClone = async () => {
    if (!cloneUrl || !localPath || !cloneName) {
      setError("Add a repo name, URL, and local folder to clone into.");
      return;
    }

    setLoading(true);
    setError("");
    try {
      await gitService.cloneRepository(cloneUrl, localPath);
      await gitService.saveRepo(cloneName, localPath);
      onRepoSelect(localPath);
      setCloneUrl("");
      setLocalPath("");
      setCloneName("");
      await loadSavedRepos();
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleOpenExisting = async () => {
    if (!repoPath || !repoName) {
      setError("Enter a repo name and an existing repository path.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await gitService.getRepositoryInfo(repoPath);
      await gitService.saveRepo(repoName, repoPath);
      onRepoSelect(repoPath);
      setRepoName("");
      setRepoPath("");
      await loadSavedRepos();
    } catch (err) {
      setError("That folder does not look like a Git repository.");
    } finally {
      setLoading(false);
    }
  };

  const handleOpenSaved = async (path: string, name: string) => {
    setLoading(true);
    setError("");
    try {
      await gitService.saveRepo(name, path);
      onRepoSelect(path);
    } catch (err) {
      setError("That repository is no longer available.");
      await loadSavedRepos();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="repo-shell">
      <div className="repo-hero">
        <div>
          <p className="eyebrow">Falck</p>
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
            <label>Repo name</label>
            <input
              type="text"
              placeholder="Marketing site"
              value={cloneName}
              onChange={(e) => setCloneName(e.target.value)}
            />
          </div>
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
            <p>Point Falck at a folder already on your disk.</p>
          </header>
          <div className="field">
            <label>Repo name</label>
            <input
              type="text"
              placeholder="Internal tools"
              value={repoName}
              onChange={(e) => setRepoName(e.target.value)}
            />
          </div>
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

      {savedRepos.length > 0 && (
        <section className="panel">
          <header className="panel-header panel-header--row">
            <div>
              <h2>Recent repositories</h2>
              <p>Pick up where you left off.</p>
            </div>
            <button className="btn ghost small" onClick={loadSavedRepos}>
              Refresh
            </button>
          </header>
          <div className="saved-list">
            {savedRepos.map((repo) => (
              <button
                key={repo.path}
                className="saved-item"
                onClick={() => handleOpenSaved(repo.path, repo.name)}
                disabled={loading}
              >
                <div>
                  <div className="saved-name">{repo.name}</div>
                  <div className="saved-path">{repo.path}</div>
                </div>
                <span className="tag muted">Open</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {error && <div className="notice error">{error}</div>}
    </div>
  );
}
