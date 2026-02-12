import { useEffect, useState } from "react";
import { useForm } from "@tanstack/react-form";

import { FormField } from "@/components/form/FormField";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  applyBranchPrefix,
  isValidBranchName,
  normalizeBranchPrefix,
  stripBranchPrefix,
} from "@/lib/branching";
import { createBranchSchema } from "@/schemas/forms";
import { BranchInfo, gitService } from "@/services/gitService";

interface BranchManagerProps {
  repoPath: string;
  onBranchChange: () => void;
  branchPrefix?: string | null;
}

export function BranchManager({
  repoPath,
  onBranchChange,
  branchPrefix,
}: BranchManagerProps) {
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [currentBranch, setCurrentBranch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const normalizedPrefix = normalizeBranchPrefix(branchPrefix);

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
    setError(null);
    try {
      await gitService.checkoutBranch(repoPath, branchName);
      setCurrentBranch(branchName);
      onBranchChange();
    } catch (err) {
      setError(String(err));
    }
  };

  const handleDeleteBranch = async (branchName: string) => {
    if (currentBranch === branchName) {
      setError("Cannot delete the current project.");
      return;
    }
    setError(null);
    try {
      await gitService.deleteBranch(repoPath, branchName);
      await loadBranches();
    } catch (err) {
      setError(String(err));
    }
  };

  const branchForm = useForm({
    defaultValues: {
      branchName: "",
    },
    validators: {
      onSubmit: createBranchSchema,
    },
    onSubmit: async ({ value }) => {
      setError(null);
      try {
        if (normalizedPrefix && !isValidBranchName(normalizedPrefix)) {
          setError(
            "Branch prefix from the Falck config contains invalid characters.",
          );
          return;
        }
        const trimmed = value.branchName.trim();
        const suffix = stripBranchPrefix(trimmed, normalizedPrefix);
        const validation =
          createBranchSchema.shape.branchName.safeParse(suffix);
        if (!validation.success) {
          setError(
            validation.error.issues[0]?.message ?? "Invalid project name.",
          );
          return;
        }
        const resolvedName = applyBranchPrefix(suffix, normalizedPrefix);
        await gitService.createBranch(repoPath, resolvedName);
        branchForm.reset();
        await loadBranches();
        onBranchChange();
      } catch (err) {
        setError(String(err));
      }
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Projects</CardTitle>
        <CardDescription>
          Switch, create, and clean up projects.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-center justify-between rounded-lg border-2 border-border bg-secondary/30 px-4 py-3 shadow-[var(--shadow-xs)]">
          <span className="text-sm text-muted-foreground">Current</span>
          <span className="text-sm font-semibold">{currentBranch || "—"}</span>
        </div>

        {loading ? (
          <div className="rounded-lg border-2 border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
            Loading projects…
          </div>
        ) : (
          <div className="space-y-2">
            {branches.map((branch) => (
              <div
                key={branch.name}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border-2 border-border bg-card/80 px-4 py-3 shadow-[var(--shadow-xs)]"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold">{branch.name}</span>
                  {branch.is_head && <Badge variant="secondary">Active</Badge>}
                </div>
                {!branch.is_head && (
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleCheckout(branch.name)}
                    >
                      Open
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => handleDeleteBranch(branch.name)}
                    >
                      Delete
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {normalizedPrefix && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border-2 border-dashed border-border/70 bg-secondary/20 px-4 py-3 text-xs text-muted-foreground shadow-[var(--shadow-xs)]">
            <span className="uppercase tracking-[0.24em]">Branch prefix</span>
            <div className="flex items-center gap-2">
              <span className="font-mono text-foreground/80">
                {normalizedPrefix}
              </span>
            </div>
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void branchForm.handleSubmit();
          }}
          className="flex flex-col gap-3 rounded-lg border-2 border-dashed border-border/70 bg-secondary/20 p-4 shadow-[var(--shadow-xs)] sm:flex-row sm:items-end"
        >
          <branchForm.Field name="branchName">
            {(field) => (
              <FormField
                field={field}
                label="New project"
                placeholder="new-project-name"
                required
              />
            )}
          </branchForm.Field>
          <Button type="submit" className="sm:mt-6">
            Create
          </Button>
        </form>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
