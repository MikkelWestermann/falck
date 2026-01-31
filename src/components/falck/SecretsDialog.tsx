import React, { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { AlertCircle, Lock } from "lucide-react";
import { falckService, Secret } from "@/services/falckService";

interface SecretsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repoPath: string;
  appId: string;
  appName: string;
  onSecretsSaved: () => void;
}

export const SecretsDialog: React.FC<SecretsDialogProps> = ({
  open,
  onOpenChange,
  repoPath,
  appId,
  appName,
  onSecretsSaved,
}) => {
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      void loadSecrets();
    }
  }, [open, appId]);

  const loadSecrets = async () => {
    setLoading(true);
    setError(null);
    try {
      const appSecrets = await falckService.getAppSecrets(repoPath, appId);
      setSecrets(appSecrets);
      const values: Record<string, string> = {};
      appSecrets.forEach((secret) => {
        values[secret.name] = "";
      });
      setSecretValues(values);
    } catch (err) {
      setError(`Failed to load secrets: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    const missingRequired = secrets.filter(
      (secret) => secret.required && !secretValues[secret.name],
    );

    if (missingRequired.length > 0) {
      setError(
        `Missing required secrets: ${missingRequired.map((s) => s.name).join(", ")}`,
      );
      return;
    }

    setSaving(true);
    setError(null);
    try {
      for (const [name, value] of Object.entries(secretValues)) {
        if (value) {
          await falckService.setSecret(name, value);
        }
      }
      onSecretsSaved();
      onOpenChange(false);
    } catch (err) {
      setError(`Failed to save secrets: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock className="h-5 w-5" />
              Loading secrets...
            </DialogTitle>
            <DialogDescription>
              Fetching secret requirements for {appName}.
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );
  }

  if (secrets.length === 0) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lock className="h-5 w-5" />
            Configure secrets for {appName}
          </DialogTitle>
          <DialogDescription>
            Secrets stay in memory while Falck is running. They are never written
            to disk.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="space-y-4 max-h-[400px] overflow-y-auto">
          {secrets.map((secret) => (
            <div key={secret.name} className="space-y-2">
              <div className="flex items-start justify-between">
                <label className="font-medium text-sm">
                  {secret.name}
                  {secret.required && (
                    <span className="text-red-500 ml-1">*</span>
                  )}
                </label>
                {!secret.required && (
                  <Badge variant="outline" className="text-xs">
                    Optional
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {secret.description}
              </p>
              <Input
                type="password"
                placeholder={`Enter ${secret.name}`}
                value={secretValues[secret.name] || ""}
                onChange={(event) =>
                  setSecretValues({
                    ...secretValues,
                    [secret.name]: event.target.value,
                  })
                }
                disabled={saving}
              />
            </div>
          ))}
        </div>

        <div className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">
          Secrets are stored in memory only while Falck is running.
        </div>

        <div className="flex gap-3">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving} className="flex-1">
            {saving ? "Saving..." : "Save secrets"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
