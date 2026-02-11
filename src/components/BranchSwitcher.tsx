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
import {
  isValidBranchName,
  normalizeBranchPrefix,
  stripBranchPrefix,
} from "@/lib/branching";
import { BranchInfo } from "@/services/gitService";

interface BranchSwitcherProps {
  branches: BranchInfo[];
  currentBranch: string;
  onSelectProject: (projectName: string) => Promise<void>;
  onCreateProject: (projectName: string) => Promise<void>;
  compact?: boolean;
  branchPrefix?: string | null;
}

export function BranchSwitcher({
  branches,
  currentBranch,
  onSelectProject,
  onCreateProject,
  branchPrefix,
  compact = false,
}: BranchSwitcherProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [branchName, setBranchName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const normalizedPrefix = normalizeBranchPrefix(branchPrefix);

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
    if (normalizedPrefix && !isValidBranchName(normalizedPrefix)) {
      setError(
        "Branch prefix from the Falck config contains invalid characters.",
      );
      return;
    }
    const suffix = stripBranchPrefix(trimmed, normalizedPrefix);
    const validation = createBranchSchema.shape.branchName.safeParse(suffix);
    if (!validation.success) {
      setError(validation.error.issues[0]?.message ?? "Invalid project name.");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await onCreateProject(suffix);
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
            <DialogDescription>
              Start a fresh project from the default.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="new-branch">Project name</Label>
            {normalizedPrefix ? (
              <div className="space-y-2">
                <div className="flex overflow-hidden rounded-md border border-input bg-background shadow-sm">
                  <div className="flex items-center gap-2 border-r border-border bg-muted/60 px-3 text-xs font-mono text-muted-foreground">
                    <span>{normalizedPrefix}</span>
                  </div>
                  <Input
                    id="new-branch"
                    value={branchName}
                    onChange={(event) => setBranchName(event.target.value)}
                    placeholder="new-project-name"
                    className="h-9 flex-1 rounded-none border-0 bg-transparent px-3 focus-visible:ring-0 focus-visible:ring-offset-0"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Prefix is set in .falck/config.yaml and cannot be changed
                  here.
                </p>
              </div>
            ) : (
              <Input
                id="new-branch"
                value={branchName}
                onChange={(event) => setBranchName(event.target.value)}
                placeholder="new-project-name"
              />
            )}
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
