import { useEffect, useState } from "react";
import { useForm } from "@tanstack/react-form";
import { zodValidator } from "@tanstack/zod-form-adapter";

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
import { createBranchSchema } from "@/schemas/forms";
import { BranchInfo, gitService } from "@/services/gitService";

interface BranchManagerProps {
  repoPath: string;
  onBranchChange: () => void;
}

export function BranchManager({ repoPath, onBranchChange }: BranchManagerProps) {
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [currentBranch, setCurrentBranch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      setError("Cannot delete the current branch.");
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
    onSubmit: async ({ value }) => {
      setError(null);
      try {
        await gitService.createBranch(repoPath, value.branchName);
        branchForm.reset();
        await loadBranches();
        onBranchChange();
      } catch (err) {
        setError(String(err));
      }
    },
    validatorAdapter: zodValidator(),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Branches</CardTitle>
        <CardDescription>Switch, create, and clean up branches.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-center justify-between rounded-lg border-2 border-border bg-secondary/30 px-4 py-3 shadow-[var(--shadow-xs)]">
          <span className="text-sm text-muted-foreground">Current</span>
          <span className="text-sm font-semibold">{currentBranch || "—"}</span>
        </div>

        {loading ? (
          <div className="rounded-lg border-2 border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
            Loading branches…
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
                  {branch.is_head && (
                    <Badge variant="secondary">
                      Checked out
                    </Badge>
                  )}
                </div>
                {!branch.is_head && (
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleCheckout(branch.name)}
                    >
                      Checkout
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

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void branchForm.handleSubmit();
          }}
          className="flex flex-col gap-3 rounded-lg border-2 border-dashed border-border/70 bg-secondary/20 p-4 shadow-[var(--shadow-xs)] sm:flex-row sm:items-end"
        >
          <branchForm.Field
            name="branchName"
            validators={{
              onChange: zodValidator(createBranchSchema.shape.branchName),
            }}
          >
            {(field) => (
              <FormField
                field={field}
                label="New branch"
                placeholder="feature/branch-name"
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
