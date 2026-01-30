import { useEffect, useState } from "react";
import { CommitInfo, gitService } from "../services/gitService";

interface CommitHistoryProps {
  repoPath: string;
}

export function CommitHistory({ repoPath }: CommitHistoryProps) {
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void loadCommits();
  }, [repoPath]);

  const loadCommits = async () => {
    setLoading(true);
    try {
      const history = await gitService.getCommitHistory(repoPath, 50);
      setCommits(history);
    } catch (err) {
      console.error("Failed to load commits:", err);
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (timestamp: number) =>
    new Date(timestamp * 1000).toLocaleString();

  return (
    <section className="panel">
      <header className="panel-header panel-header--row">
        <div>
          <h2>Commit history</h2>
          <p>Latest activity from the current branch.</p>
        </div>
        <button className="btn ghost small" onClick={loadCommits}>
          Refresh
        </button>
      </header>

      {loading ? (
        <div className="empty">Loading commits…</div>
      ) : commits.length === 0 ? (
        <div className="empty">No commits found.</div>
      ) : (
        <div className="commit-list">
          {commits.map((commit) => (
            <div className="commit-item" key={commit.id}>
              <div className="commit-hash">
                {commit.id.substring(0, 7)}
              </div>
              <div className="commit-body">
                <div className="commit-message">{commit.message}</div>
                <div className="commit-meta">
                  {commit.author} · {formatDate(commit.timestamp)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
