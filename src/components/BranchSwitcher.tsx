import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createBranchSchema } from "@/schemas/forms";
import { BranchInfo, gitService } from "@/services/gitService";

interface BranchSwitcherProps {
  repoPath: string;
  branches: BranchInfo[];
  currentBranch: string;
  onBranchChange: () => void;
  compact?: boolean;
}

export function BranchSwitcher({
  repoPath,
  branches,
  currentBranch,
  onBranchChange,
  compact = false,
}: BranchSwitcherProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [branchName, setBranchName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSelect = async (value: string) => {
    if (value === "__create__") {
      setCreateOpen(true);
      return;
    }
    if (value === currentBranch) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await gitService.checkoutBranch(repoPath, value);
      onBranchChange();
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleCreateBranch = async () => {
    const trimmed = branchName.trim();
    const validation = createBranchSchema.shape.branchName.safeParse(trimmed);
    if (!validation.success) {
      setError(validation.error.issues[0]?.message ?? "Invalid branch name.");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await gitService.createBranch(repoPath, trimmed);
      await gitService.checkoutBranch(repoPath, trimmed);
      setBranchName("");
      setCreateOpen(false);
      onBranchChange();
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={compact ? "space-y-1" : "space-y-2"}>
      <Label className={compact ? "sr-only" : undefined}>Branch</Label>
      <Select value={currentBranch} onValueChange={handleSelect}>
        <SelectTrigger disabled={loading}>
          <SelectValue placeholder="Select branch" />
        </SelectTrigger>
        <SelectContent>
          {branches.map((branch) => (
            <SelectItem key={branch.name} value={branch.name}>
              {branch.name}
            </SelectItem>
          ))}
          <SelectItem value="__create__">+ Create new branch</SelectItem>
        </SelectContent>
      </Select>

      {error && !createOpen && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Dialog
        open={createOpen}
        onOpenChange={(nextOpen) => {
          setCreateOpen(nextOpen);
          if (!nextOpen) {
            setBranchName("");
            setError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create new branch</DialogTitle>
            <DialogDescription>Spin up a fresh branch for this work.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="new-branch">Branch name</Label>
            <Input
              id="new-branch"
              value={branchName}
              onChange={(event) => setBranchName(event.target.value)}
              placeholder="feature/branch-name"
            />
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateOpen(false)}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button onClick={handleCreateBranch} disabled={loading}>
              {loading ? "Creating..." : "Create branch"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
