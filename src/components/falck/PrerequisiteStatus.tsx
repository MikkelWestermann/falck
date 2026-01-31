import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PrerequisiteCheckResult } from "@/services/falckService";
import { CheckCircle2, AlertCircle, CircleHelp } from "lucide-react";

interface PrerequisiteStatusProps {
  result: PrerequisiteCheckResult;
  onOpenInstallUrl?: (url: string) => void;
}

export function PrerequisiteStatus({
  result,
  onOpenInstallUrl,
}: PrerequisiteStatusProps) {
  const needsUpdate =
    !result.installed && result.current_version && result.required_version;
  const statusLabel = result.installed
    ? "Installed"
    : needsUpdate
      ? "Update needed"
      : result.optional
        ? "Optional"
        : "Missing";

  const StatusIcon = result.installed
    ? CheckCircle2
    : needsUpdate || !result.optional
      ? AlertCircle
      : CircleHelp;

  return (
    <div className="flex flex-col gap-3 rounded-lg border-2 border-border bg-card/70 px-4 py-3 shadow-[var(--shadow-xs)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <StatusIcon className="h-4 w-4 text-foreground/70" />
          <span className="font-medium text-sm">{result.name}</span>
        </div>
        <Badge variant={result.installed ? "secondary" : "outline"}>
          {statusLabel}
        </Badge>
      </div>
      <div className="text-xs text-muted-foreground space-y-1">
        {result.required_version && (
          <p>Required: v{result.required_version}</p>
        )}
        {result.current_version ? (
          <p>Detected: v{result.current_version}</p>
        ) : (
          <p>No version detected</p>
        )}
      </div>
      {result.install_url && onOpenInstallUrl ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => onOpenInstallUrl(result.install_url!)}
        >
          Open install page
        </Button>
      ) : null}
    </div>
  );
}
