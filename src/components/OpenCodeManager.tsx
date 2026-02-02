import { useCallback, useEffect, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  clearOpenCodeReminder,
  dismissOpenCodeReminder,
  shouldShowOpenCodeReminder,
} from "@/lib/opencodeReminder";
import {
  opencodeService,
  type OpenCodeInstallResult,
  type OpenCodeStatus,
} from "@/services/opencodeService";

interface OpenCodeManagerProps {
  autoCheck?: boolean;
  onStatusChange?: (status: OpenCodeStatus) => void;
}

interface OpenCodeInstallState {
  status: OpenCodeStatus | null;
  isChecking: boolean;
  isInstalling: boolean;
  error: string | null;
  setError: (value: string | null) => void;
  checkStatus: () => Promise<OpenCodeStatus>;
  install: () => Promise<OpenCodeInstallResult>;
  openInstallDocs: () => Promise<void>;
  openWindowsInstaller: () => Promise<void>;
}

function useOpenCodeInstallState(): OpenCodeInstallState {
  const [status, setStatus] = useState<OpenCodeStatus | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkStatus = useCallback(async () => {
    setIsChecking(true);
    setError(null);
    const nextStatus = await opencodeService.checkInstalled();
    setStatus(nextStatus);
    setIsChecking(false);
    return nextStatus;
  }, []);

  const install = useCallback(async () => {
    setIsInstalling(true);
    setError(null);
    try {
      const result = await opencodeService.install();
      if (!result.success && !result.requiresManualInstall) {
        setError(result.message);
      }
      return result;
    } catch (err) {
      const message = `Installation failed: ${String(err)}`;
      setError(message);
      return {
        success: false,
        message,
      };
    } finally {
      setIsInstalling(false);
    }
  }, []);

  const openInstallDocs = useCallback(() => opencodeService.openInstallDocs(), []);
  const openWindowsInstaller = useCallback(
    () => opencodeService.openWindowsInstaller(),
    [],
  );

  return {
    status,
    isChecking,
    isInstalling,
    error,
    setError,
    checkStatus,
    install,
    openInstallDocs,
    openWindowsInstaller,
  };
}

function statusBadgeVariant(status: OpenCodeStatus | null) {
  if (!status) {
    return "outline" as const;
  }
  return status.installed ? "secondary" : "destructive";
}

function statusLabel(status: OpenCodeStatus | null) {
  if (!status) {
    return "Checking...";
  }
  return status.installed ? "Installed" : "Not installed";
}

export function OpenCodeManager({
  autoCheck = true,
  onStatusChange,
}: OpenCodeManagerProps) {
  const {
    status,
    isChecking,
    isInstalling,
    error,
    setError,
    checkStatus,
    install,
    openInstallDocs,
    openWindowsInstaller,
  } = useOpenCodeInstallState();
  const [open, setOpen] = useState(false);

  const runCheck = useCallback(async () => {
    const nextStatus = await checkStatus();
    onStatusChange?.(nextStatus);

    if (nextStatus.installed) {
      clearOpenCodeReminder();
      setOpen(false);
      return nextStatus;
    }

    if (autoCheck && shouldShowOpenCodeReminder()) {
      setOpen(true);
    }

    return nextStatus;
  }, [autoCheck, checkStatus, onStatusChange]);

  useEffect(() => {
    if (autoCheck) {
      void runCheck();
    }
  }, [autoCheck, runCheck]);

  const handleInstall = async () => {
    setError(null);
    const result = await install();

    if (result.requiresManualInstall) {
      await openWindowsInstaller();
      setError(
        "Windows requires a manual OpenCode install. Download it, then click Check again.",
      );
      return;
    }

    if (result.success) {
      await runCheck();
      return;
    }

    if (result.message) {
      setError(result.message);
    }
  };

  const handleManualInstall = async () => {
    setError(null);
    await openInstallDocs();
  };

  const handleCheckAgain = async () => {
    setError(null);
    await runCheck();
  };

  const handleRemindLater = () => {
    dismissOpenCodeReminder();
    setOpen(false);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && status && !status.installed) {
      dismissOpenCodeReminder();
    }
    setOpen(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>OpenCode required</DialogTitle>
          <DialogDescription>
            Falck uses OpenCode for AI sessions. Install it to continue.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg border-2 border-border bg-secondary/20 p-4">
            <div className="text-xs font-semibold uppercase tracking-[0.25em] text-muted-foreground">
              Status
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge variant={statusBadgeVariant(status)}>
                {statusLabel(status)}
              </Badge>
              {status?.version && (
                <span className="text-xs text-muted-foreground">
                  {status.version}
                </span>
              )}
            </div>
            {status?.path && (
              <div className="mt-2 text-xs font-mono text-muted-foreground break-all">
                {status.path}
              </div>
            )}
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="grid gap-2 sm:grid-cols-2">
            <Button
              onClick={handleInstall}
              disabled={isInstalling || isChecking}
              className="normal-case tracking-normal"
            >
              {isInstalling ? "Installing..." : "Install OpenCode"}
            </Button>
            <Button
              variant="outline"
              onClick={handleManualInstall}
              disabled={isInstalling}
              className="normal-case tracking-normal"
            >
              Manual install
            </Button>
            <Button
              variant="ghost"
              className="sm:col-span-2 normal-case tracking-normal"
              onClick={handleCheckAgain}
              disabled={isChecking || isInstalling}
            >
              {isChecking ? "Checking..." : "Check again"}
            </Button>
          </div>

          <Button
            variant="ghost"
            className="w-full normal-case tracking-normal"
            onClick={handleRemindLater}
          >
            Remind me later
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface OpenCodeInstallPanelProps {
  className?: string;
}

export function OpenCodeInstallPanel({ className }: OpenCodeInstallPanelProps) {
  const {
    status,
    isChecking,
    isInstalling,
    error,
    setError,
    checkStatus,
    install,
    openInstallDocs,
    openWindowsInstaller,
  } = useOpenCodeInstallState();

  useEffect(() => {
    void checkStatus();
  }, [checkStatus]);

  const handleInstall = async () => {
    setError(null);
    const result = await install();

    if (result.requiresManualInstall) {
      await openWindowsInstaller();
      setError(
        "Windows requires a manual OpenCode install. Download it, then click Check again.",
      );
      return;
    }

    if (result.success) {
      await checkStatus();
    }
  };

  const handleManualInstall = async () => {
    setError(null);
    await openInstallDocs();
  };

  const handleCheckAgain = async () => {
    setError(null);
    await checkStatus();
  };

  const primaryAction = status?.installed ? handleCheckAgain : handleInstall;
  const primaryLabel = status?.installed
    ? isChecking
      ? "Checking..."
      : "Re-check"
    : isInstalling
      ? "Installing..."
      : "Install OpenCode";

  return (
    <Card className={className}>
      <CardHeader className="border-b border-border/60 pb-5">
        <CardTitle>OpenCode dependency</CardTitle>
        <CardDescription>
          OpenCode is required for the AI features in Falck.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pt-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="text-sm font-semibold">Status</div>
            <div className="text-xs text-muted-foreground">
              {status?.installed
                ? "OpenCode detected"
                : status
                  ? "OpenCode not found in PATH"
                  : "Checking OpenCode..."}
            </div>
            {status?.version && (
              <div className="text-xs text-muted-foreground">
                {status.version}
              </div>
            )}
            {status?.path && (
              <div className="text-xs font-mono text-muted-foreground break-all">
                {status.path}
              </div>
            )}
          </div>
          <Badge variant={statusBadgeVariant(status)}>
            {statusLabel(status)}
          </Badge>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            onClick={primaryAction}
            disabled={isChecking || isInstalling}
            className="normal-case tracking-normal"
          >
            {primaryLabel}
          </Button>
          <Button
            variant="outline"
            onClick={handleManualInstall}
            disabled={isInstalling}
            className="normal-case tracking-normal"
          >
            Manual install
          </Button>
          {!status?.installed && (
            <Button
              variant="ghost"
              onClick={handleCheckAgain}
              disabled={isChecking || isInstalling}
              className="normal-case tracking-normal"
            >
              {isChecking ? "Checking..." : "Check again"}
            </Button>
          )}
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
