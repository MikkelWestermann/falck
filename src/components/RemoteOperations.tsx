import { useEffect, useState } from "react";
import { gitService } from "../services/gitService";

interface RemoteOperationsProps {
  repoPath: string;
  currentBranch: string;
}

export function RemoteOperations({
  repoPath,
  currentBranch,
}: RemoteOperationsProps) {
  const [remotes, setRemotes] = useState<string[]>([]);
  const [selectedRemote, setSelectedRemote] = useState("origin");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    void loadRemotes();
  }, [repoPath]);

  const loadRemotes = async () => {
    try {
      const remoteList = await gitService.getRemotes(repoPath);
      setRemotes(remoteList);
      if (remoteList.length > 0) {
        setSelectedRemote(remoteList[0]);
      }
    } catch (err) {
      console.error("Failed to load remotes:", err);
    }
  };

  const handlePush = async () => {
    setLoading(true);
    setError("");
    setMessage("");
    try {
      await gitService.push(repoPath, selectedRemote, currentBranch);
      setMessage(`Pushed to ${selectedRemote}/${currentBranch}`);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const handlePull = async () => {
    setLoading(true);
    setError("");
    setMessage("");
    try {
      await gitService.pull(repoPath, selectedRemote, currentBranch);
      setMessage(`Pulled from ${selectedRemote}/${currentBranch}`);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="panel">
      <header className="panel-header">
        <h2>Remote operations</h2>
        <p>Sync changes with your configured remote.</p>
      </header>

      {remotes.length === 0 ? (
        <div className="empty">No remotes configured.</div>
      ) : (
        <>
          <div className="field inline">
            <label>Remote</label>
            <select
              value={selectedRemote}
              onChange={(e) => setSelectedRemote(e.target.value)}
            >
              {remotes.map((remote) => (
                <option key={remote} value={remote}>
                  {remote}
                </option>
              ))}
            </select>
            <div className="tag muted">{currentBranch}</div>
          </div>

          <div className="button-row">
            <button
              className="btn ghost"
              onClick={handlePull}
              disabled={loading}
            >
              {loading ? "Pulling…" : "Pull"}
            </button>
            <button
              className="btn primary"
              onClick={handlePush}
              disabled={loading}
            >
              {loading ? "Pushing…" : "Push"}
            </button>
          </div>
        </>
      )}

      {error && <div className="notice error">{error}</div>}
      {message && <div className="notice success">{message}</div>}
    </section>
  );
}
