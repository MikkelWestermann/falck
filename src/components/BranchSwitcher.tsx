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
import { BranchInfo } from "@/services/gitService";

interface BranchSwitcherProps {
  branches: BranchInfo[];
  currentBranch: string;
  onSelectProject: (projectName: string) => Promise<void>;
  onCreateProject: (projectName: string) => Promise<void>;
  compact?: boolean;
}

export function BranchSwitcher({
  branches,
  currentBranch,
  onSelectProject,
  onCreateProject,
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
      await onSelectProject(value);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleCreateProject = async () => {
    const trimmed = branchName.trim();
    const validation = createBranchSchema.shape.branchName.safeParse(trimmed);
    if (!validation.success) {
      setError(validation.error.issues[0]?.message ?? "Invalid project name.");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await onCreateProject(trimmed);
      setBranchName("");
      setCreateOpen(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={compact ? "space-y-1" : "space-y-2"}>
      <Label className={compact ? "sr-only" : undefined}>Project</Label>
      <Select value={currentBranch} onValueChange={handleSelect}>
        <SelectTrigger disabled={loading}>
          <SelectValue placeholder="Select project" />
        </SelectTrigger>
        <SelectContent>
          {branches.map((branch) => (
            <SelectItem key={branch.name} value={branch.name}>
              {branch.name}
            </SelectItem>
          ))}
          <SelectItem value="__create__">+ Create new project</SelectItem>
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
            <DialogTitle>Create new project</DialogTitle>
            <DialogDescription>Start a fresh project from the default.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="new-branch">Project name</Label>
            <Input
              id="new-branch"
              value={branchName}
              onChange={(event) => setBranchName(event.target.value)}
              placeholder="new-project-name"
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
            <Button onClick={handleCreateProject} disabled={loading}>
              {loading ? "Creating..." : "Create project"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
