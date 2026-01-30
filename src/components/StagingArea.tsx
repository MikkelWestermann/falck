import { useEffect, useState } from "react";
import { FileStatus, gitService } from "../services/gitService";

interface StagingAreaProps {
  repoPath: string;
  onCommit: () => void;
}

const statusLabel: Record<FileStatus["status"], string> = {
  modified: "Modified",
  added: "Added",
  deleted: "Deleted",
  renamed: "Renamed",
  untracked: "Untracked",
  unknown: "Unknown",
};

export function StagingArea({ repoPath, onCommit }: StagingAreaProps) {
  const [files, setFiles] = useState<FileStatus[]>([]);
  const [message, setMessage] = useState("");
  const [author, setAuthor] = useState("Your Name");
  const [email, setEmail] = useState("you@example.com");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void loadStatus();
  }, [repoPath]);

  const loadStatus = async () => {
    try {
      const info = await gitService.getRepositoryInfo(repoPath);
      setFiles(info.status_files);
    } catch (err) {
      console.error("Failed to load status:", err);
    }
  };

  const handleStageFile = async (filePath: string) => {
    try {
      await gitService.stageFile(repoPath, filePath);
      await loadStatus();
    } catch (err) {
      setError(String(err));
    }
  };

  const handleCommit = async () => {
    if (!message) {
      setError("Commit message required.");
      return;
    }

    setLoading(true);
    setError("");
    try {
      await gitService.createCommit(repoPath, message, author, email);
      setMessage("");
      await loadStatus();
      onCommit();
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const hasChanges = files.length > 0;

  return (
    <section className="panel">
      <header className="panel-header">
        <h2>Staging area</h2>
        <p>Pick files to stage and craft a commit.</p>
      </header>

      {!hasChanges ? (
        <div className="empty">No changes to commit.</div>
      ) : (
        <div className="file-list">
          {files.map((file) => (
            <div className="file-item" key={file.path}>
              <div className="file-path">
                <span className={`status-pill ${file.status}`}>
                  {statusLabel[file.status]}
                </span>
                {file.path}
              </div>
              <button
                className="btn ghost tiny"
                onClick={() => handleStageFile(file.path)}
              >
                Stage
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="divider" />

      <div className="commit-form">
        <h3>Create commit</h3>
        <div className="field">
          <label>Author name</label>
          <input
            type="text"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Author email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Commit message</label>
          <textarea
            rows={4}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Summarize what changed"
          />
        </div>
        <button
          className="btn primary"
          onClick={handleCommit}
          disabled={loading || !hasChanges}
        >
          {loading ? "Committing…" : "Commit"}
        </button>
      </div>

      {error && <div className="notice error">{error}</div>}
    </section>
  );
}
