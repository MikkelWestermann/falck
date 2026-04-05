import React, { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  AlertCircle,
  Eye,
  EyeOff,
  FileText,
  KeyRound,
  Loader2,
  Lock,
  Trash2,
  UploadCloudIcon,
} from "lucide-react";
import {
  falckService,
  type AppSecretStatus,
  type SecretStatus,
} from "@/services/falckService";

interface SecretsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repoPath: string;
  appId: string;
  appName: string;
  appRoot: string;
  onSecretsSaved: () => void;
}

const normalizeRepoRelativePath = (value: string) => {
  let normalized = value.trim().replace(/\\/g, "/");
  if (normalized === "." || normalized === "./") {
    return "";
  }
  normalized = normalized.replace(/^\.\//, "");
  normalized = normalized.replace(/^\/+/, "");
  normalized = normalized.replace(/\/+$/, "");
  return normalized;
};

const getSecretBadge = (secret: SecretStatus) => {
  if (secret.configured) {
    return (
      <Badge variant="secondary" className="shrink-0 text-xs font-normal">
        {secret.source === "env_file" ? "From env file" : "Saved"}
      </Badge>
    );
  }

  if (!secret.required) {
    return (
      <Badge variant="outline" className="shrink-0 text-xs font-normal">
        Optional
      </Badge>
    );
  }

  return (
    <Badge variant="destructive" className="shrink-0 text-xs font-normal">
      Missing
    </Badge>
  );
};

export const SecretsDialog: React.FC<SecretsDialogProps> = ({
  open,
  onOpenChange,
  repoPath,
  appId,
  appName,
  appRoot,
  onSecretsSaved,
}) => {
  const [secretStatus, setSecretStatus] = useState<AppSecretStatus | null>(null);
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [envFileDirectory, setEnvFileDirectory] = useState("");
  const [envFileName, setEnvFileName] = useState("");
  const [envFileContent, setEnvFileContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [clearingEnvFile, setClearingEnvFile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPasswords, setShowPasswords] = useState(false);
  const [mainTab, setMainTab] = useState<"env" | "secrets">("env");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const secrets = secretStatus?.secrets ?? [];
  const currentEnvFile = secretStatus?.env_file ?? null;
  const busy = saving || clearingEnvFile;
  const defaultEnvDirectory = normalizeRepoRelativePath(appRoot);

  const configuredSecrets = secrets.filter((s) => s.configured).length;
  const missingRequired = secrets.filter(
    (s) => s.required && !s.configured,
  ).length;

  useEffect(() => {
    if (open) {
      void loadSecrets();
    }
  }, [open, repoPath, appId, defaultEnvDirectory]);

  useEffect(() => {
    if (!open || !secretStatus) {
      return;
    }
    const hasMissingRequired = secretStatus.secrets.some(
      (s) => s.required && !s.configured,
    );
    setMainTab(hasMissingRequired ? "secrets" : "env");
  }, [open, secretStatus]);

  const loadSecrets = async () => {
    setLoading(true);
    setError(null);
    try {
      const nextStatus = await falckService.getAppSecretStatus(repoPath, appId);
      setSecretStatus(nextStatus);
      const values: Record<string, string> = {};
      nextStatus.secrets.forEach((secret) => {
        values[secret.name] = "";
      });
      setSecretValues(values);
      setEnvFileDirectory(nextStatus.env_file?.directory ?? defaultEnvDirectory);
      setEnvFileName(nextStatus.env_file?.name ?? "");
      setEnvFileContent("");
      setShowPasswords(false);
    } catch (err) {
      setError(`Failed to load secrets: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleDialogOpenChange = (nextOpen: boolean) => {
    if (busy) {
      return;
    }
    onOpenChange(nextOpen);
  };

  const handleEnvFileUploadClick = () => {
    if (!fileInputRef.current || busy) {
      return;
    }
    fileInputRef.current.value = "";
    fileInputRef.current.click();
  };

  const handleEnvFileSelected = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      const contents = await file.text();
      setEnvFileName(file.name);
      setEnvFileContent(contents);
      setError(null);
    } catch (err) {
      setError(`Failed to read env file: ${String(err)}`);
    }
  };

  const handleClearEnvFile = async () => {
    setClearingEnvFile(true);
    setError(null);
    try {
      await falckService.clearAppEnvFile(repoPath, appId);
      await loadSecrets();
      onSecretsSaved();
    } catch (err) {
      setError(`Failed to clear env file: ${String(err)}`);
    } finally {
      setClearingEnvFile(false);
    }
  };

  const handleSave = async () => {
    const normalizedDirectory = normalizeRepoRelativePath(envFileDirectory);
    const currentDirectory = currentEnvFile?.directory ?? defaultEnvDirectory;
    const currentName = currentEnvFile?.name ?? "";
    const envFilePathChanged =
      normalizedDirectory !== currentDirectory ||
      envFileName.trim() !== currentName;

    if (envFileContent.length > 0 && !envFileName.trim()) {
      setError("Enter an env file name before saving pasted or uploaded content.");
      return;
    }
    if (envFileContent.length === 0 && envFilePathChanged) {
      setError(
        "Paste or upload env contents before saving a new file name or repo location.",
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

      if (envFileContent.length > 0) {
        await falckService.setAppEnvFile(
          repoPath,
          appId,
          normalizedDirectory,
          envFileName.trim(),
          envFileContent,
        );
      }

      const nextStatus = await falckService.getAppSecretStatus(repoPath, appId);
      setSecretStatus(nextStatus);
      onSecretsSaved();

      const missingRequiredList = nextStatus.secrets.filter(
        (secret) => secret.required && !secret.configured,
      );
      if (missingRequiredList.length > 0) {
        setError(
          `Missing required secrets: ${missingRequiredList.map((secret) => secret.name).join(", ")}`,
        );
        return;
      }

      onOpenChange(false);
    } catch (err) {
      setError(`Failed to save secrets: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Dialog open={open} onOpenChange={handleDialogOpenChange}>
        <DialogContent className="!flex max-w-md flex-col items-center justify-center gap-4 py-12 sm:max-w-md">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
          <div className="space-y-1 text-center">
            <DialogTitle className="text-base">Loading environment</DialogTitle>
            <DialogDescription>
              Reading saved configuration for {appName}.
            </DialogDescription>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  if (!secretStatus) {
    return null;
  }

  const hasDeclaredSecrets = secrets.length > 0;
  const envLinked = Boolean(currentEnvFile);

  const envFilePanel = (
    <Card className="border-border/80 shadow-none">
      <CardHeader className="space-y-1 pb-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText className="h-4 w-4 text-muted-foreground" />
              Managed env file
            </CardTitle>
            <CardDescription>
              Store a real <span className="font-mono text-xs">.env</span> in
              the repo at a path you choose. Upload, paste, or leave unchanged.
            </CardDescription>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleEnvFileUploadClick}
              disabled={busy}
            >
              <UploadCloudIcon className="mr-2 h-4 w-4" />
              Upload
            </Button>
            {currentEnvFile && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleClearEnvFile}
                disabled={busy}
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Remove file
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={handleEnvFileSelected}
          disabled={busy}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="env-file-directory">Folder in repo</Label>
            <Input
              id="env-file-directory"
              value={envFileDirectory}
              onChange={(event) => setEnvFileDirectory(event.target.value)}
              placeholder={defaultEnvDirectory || "repo root"}
              disabled={busy}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Relative to repo root. Empty means the repository root.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="env-file-name">File name</Label>
            <Input
              id="env-file-name"
              value={envFileName}
              onChange={(event) => setEnvFileName(event.target.value)}
              placeholder=".env.local"
              disabled={busy}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Examples: <span className="font-mono">.env</span>,{" "}
              <span className="font-mono">.env.development</span>
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="env-file-content">Contents</Label>
            {envFileContent.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {envFileContent.split(/\r?\n/).filter(Boolean).length} lines ·{" "}
                {envFileContent.length} chars
              </span>
            )}
          </div>
          <Textarea
            id="env-file-content"
            value={envFileContent}
            onChange={(event) => setEnvFileContent(event.target.value)}
            placeholder={`KEY=value
ANOTHER_KEY=...`}
            className="min-h-[200px] resize-y font-mono text-xs leading-relaxed"
            disabled={busy}
            spellCheck={false}
          />
          <p className="text-xs text-muted-foreground">
            Leave empty to keep the existing managed file. Saving with new text
            replaces it.
          </p>
        </div>

        {currentEnvFile ? (
          <div className="rounded-lg border border-border/80 bg-muted/40 px-3 py-2.5 text-sm">
            <p className="text-xs font-medium text-muted-foreground">
              Active file
            </p>
            <p className="mt-1 break-all font-mono text-xs text-foreground">
              {currentEnvFile.repo_relative_path}
            </p>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {currentEnvFile.variable_count} variable
              {currentEnvFile.variable_count === 1 ? "" : "s"} loaded from disk.
            </p>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border/80 bg-muted/20 px-3 py-3 text-sm text-muted-foreground">
            No env file is linked for this app yet. Paste or upload to create
            one.
          </div>
        )}
      </CardContent>
    </Card>
  );

  const secretsPanel = (
    <Card className="border-border/80 shadow-none">
      <CardHeader className="space-y-1 pb-4">
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          Declared secrets
        </CardTitle>
        <CardDescription>
          Values you type here are saved in Falck. Leave a field empty to keep
          whatever is already configured (including values from your env file).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        <div className="flex items-center justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 text-xs text-muted-foreground"
            onClick={() => setShowPasswords((v) => !v)}
            disabled={busy}
          >
            {showPasswords ? (
              <>
                <EyeOff className="mr-1.5 h-3.5 w-3.5" />
                Hide values
              </>
            ) : (
              <>
                <Eye className="mr-1.5 h-3.5 w-3.5" />
                Show values
              </>
            )}
          </Button>
        </div>

        <div className="space-y-3">
          {secrets.map((secret) => (
            <div
              key={secret.name}
              className="rounded-lg border border-border/60 bg-background/60 p-3"
            >
              <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-medium">
                      {secret.name}
                    </span>
                    {secret.required && (
                      <Badge
                        variant="outline"
                        className="h-5 px-1.5 text-[10px] font-normal uppercase tracking-wide text-muted-foreground"
                      >
                        Required
                      </Badge>
                    )}
                  </div>
                  {secret.description ? (
                    <p className="text-xs text-muted-foreground">
                      {secret.description}
                    </p>
                  ) : null}
                </div>
                {getSecretBadge(secret)}
              </div>

              <Input
                type={showPasswords ? "text" : "password"}
                autoComplete="off"
                placeholder={
                  secret.configured
                    ? "Leave blank to keep current value"
                    : `Enter ${secret.name}`
                }
                value={secretValues[secret.name] || ""}
                onChange={(event) =>
                  setSecretValues((current) => ({
                    ...current,
                    [secret.name]: event.target.value,
                  }))
                }
                disabled={busy}
                className="font-mono text-sm"
              />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent className="!flex max-h-[90vh] max-w-3xl flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <div className="space-y-4 px-6 pb-2 pt-6">
          <DialogHeader className="space-y-4 text-left">
            <div className="flex gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10">
                <Lock className="h-5 w-5 text-primary" />
              </div>
              <div className="min-w-0 space-y-2">
                <div>
                  <DialogTitle className="text-xl font-semibold tracking-tight">
                    Environment & secrets
                  </DialogTitle>
                  <DialogDescription className="mt-1.5 text-pretty">
                    <span className="font-medium text-foreground">
                      {appName}
                    </span>
                    {" — "}
                    Configure a repo env file and any secrets this app declares.
                    Falck checks both before launch.
                  </DialogDescription>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Badge
                    variant="outline"
                    className="gap-1.5 font-normal"
                  >
                    <span
                      className={
                        envLinked
                          ? "h-2 w-2 rounded-full bg-emerald-500"
                          : "h-2 w-2 rounded-full bg-muted-foreground/40"
                      }
                      aria-hidden
                    />
                    {envLinked ? "Env file linked" : "No env file yet"}
                  </Badge>
                  {hasDeclaredSecrets && (
                    <Badge variant="outline" className="font-normal">
                      Secrets {configuredSecrets}/{secrets.length} set
                    </Badge>
                  )}
                  {missingRequired > 0 && (
                    <Badge variant="destructive" className="font-normal">
                      {missingRequired} required missing
                    </Badge>
                  )}
                </div>
              </div>
            </div>
          </DialogHeader>
        </div>

        <Separator />

        {error && (
          <div className="px-6 pt-4">
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </div>
        )}

        <ScrollArea className="min-h-0 flex-1 px-6">
          <div className="space-y-4 py-4 pr-3">
            {hasDeclaredSecrets ? (
              <Tabs
                value={mainTab}
                onValueChange={(v) => setMainTab(v as "env" | "secrets")}
                className="gap-4"
              >
                <TabsList className="grid w-full grid-cols-2 sm:w-auto sm:grid-cols-none sm:inline-flex">
                  <TabsTrigger value="env" className="gap-2">
                    <FileText className="h-3.5 w-3.5 opacity-70" />
                    Env file
                  </TabsTrigger>
                  <TabsTrigger value="secrets" className="gap-2">
                    <KeyRound className="h-3.5 w-3.5 opacity-70" />
                    Secrets
                    <Badge
                      variant="secondary"
                      className="ml-0.5 h-5 min-w-[1.25rem] px-1.5 text-[10px] font-normal"
                    >
                      {secrets.length}
                    </Badge>
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="env" className="mt-4">
                  {envFilePanel}
                </TabsContent>
                <TabsContent value="secrets" className="mt-4">
                  {secretsPanel}
                </TabsContent>
              </Tabs>
            ) : (
              envFilePanel
            )}
          </div>
        </ScrollArea>

        <Separator />

        <DialogFooter className="flex-col gap-3 border-t bg-muted/30 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-center text-xs text-muted-foreground sm:flex-1 sm:text-left">
            Manual secrets and the managed env file are merged when Falck checks
            whether the app is ready to run.
          </p>
          <div className="flex w-full gap-2 sm:w-auto">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={busy}
              className="flex-1 sm:flex-none"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleSave}
              disabled={busy}
              className="flex-1 sm:min-w-[140px] sm:flex-none"
            >
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving
                </>
              ) : (
                "Save changes"
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
