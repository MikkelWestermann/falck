import { useEffect, useState } from "react";
import { BranchInfo, gitService } from "../services/gitService";

interface BranchManagerProps {
  repoPath: string;
  onBranchChange: () => void;
}

export function BranchManager({ repoPath, onBranchChange }: BranchManagerProps) {
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [currentBranch, setCurrentBranch] = useState("");
  const [newBranchName, setNewBranchName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void loadBranches();
  }, [repoPath]);

  const loadBranches = async () => {
    setLoading(true);
    try {
      const info = await gitService.getRepositoryInfo(repoPath);
      setBranches(info.branches);
      setCurrentBranch(info.head_branch);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleCheckout = async (branchName: string) => {
    setError("");
    try {
      await gitService.checkoutBranch(repoPath, branchName);
      setCurrentBranch(branchName);
      onBranchChange();
    } catch (err) {
      setError(String(err));
    }
  };

  const handleCreateBranch = async () => {
    if (!newBranchName) {
      setError("Branch name required.");
      return;
    }
    setError("");
    try {
      await gitService.createBranch(repoPath, newBranchName);
      setNewBranchName("");
      await loadBranches();
      onBranchChange();
    } catch (err) {
      setError(String(err));
    }
  };

  const handleDeleteBranch = async (branchName: string) => {
    if (currentBranch === branchName) {
      setError("Cannot delete the current branch.");
      return;
    }
    setError("");
    try {
      await gitService.deleteBranch(repoPath, branchName);
      await loadBranches();
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <section className="panel">
      <header className="panel-header">
        <h2>Branches</h2>
        <p>Switch, create, and clean up branches.</p>
      </header>

      <div className="branch-current">
        <span>Current</span>
        <strong>{currentBranch || "—"}</strong>
      </div>

      {loading ? (
        <div className="empty">Loading branches…</div>
      ) : (
        <div className="branch-list">
          {branches.map((branch) => (
            <div className="branch-item" key={branch.name}>
              <div className="branch-name">
                {branch.name}
                {branch.is_head && <span className="tag">Checked out</span>}
              </div>
              {!branch.is_head && (
                <div className="branch-actions">
                  <button
                    className="btn ghost tiny"
                    onClick={() => handleCheckout(branch.name)}
                  >
                    Checkout
                  </button>
                  <button
                    className="btn danger tiny"
                    onClick={() => handleDeleteBranch(branch.name)}
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="divider" />

      <div className="field inline">
        <label>New branch</label>
        <input
          type="text"
          placeholder="feature/branch-name"
          value={newBranchName}
          onChange={(e) => setNewBranchName(e.target.value)}
        />
        <button className="btn primary" onClick={handleCreateBranch}>
          Create
        </button>
      </div>

      {error && <div className="notice error">{error}</div>}
    </section>
  );
}
