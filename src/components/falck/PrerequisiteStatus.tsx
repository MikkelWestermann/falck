import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Prerequisite, PrerequisiteCheckResult } from "@/services/falckService";
import { CheckCircle2, AlertCircle, CircleHelp } from "lucide-react";

interface PrerequisiteStatusProps {
  prereq: Prerequisite;
  result?: PrerequisiteCheckResult;
  onOpenInstallUrl?: (url: string) => void;
  onRunInstallOption?: (optionIndex: number) => void;
  isOptionRunning?: (optionIndex: number) => boolean;
  installMessage?: string;
  installError?: string;
}

export function PrerequisiteStatus({
  prereq,
  result,
  onOpenInstallUrl,
  onRunInstallOption,
  isOptionRunning,
  installMessage,
  installError,
}: PrerequisiteStatusProps) {
  const hasResult = Boolean(result);
  const needsUpdate =
    Boolean(result?.current_version && result?.required_version) &&
    !result?.installed;
  const isInstalled = Boolean(result?.installed);
  const isOptional = result?.optional ?? prereq.optional ?? false;
  const statusLabel = !hasResult
    ? "Unknown"
    : isInstalled
      ? "Installed"
      : needsUpdate
        ? "Update needed"
        : isOptional
          ? "Optional"
          : "Missing";

  const StatusIcon = !hasResult
    ? CircleHelp
    : isInstalled
      ? CheckCircle2
      : needsUpdate || !isOptional
        ? AlertCircle
        : CircleHelp;

  const instructions = prereq.install?.instructions;
  const instructionList = Array.isArray(instructions)
    ? instructions
    : instructions
      ? [instructions]
      : [];
  const installOptions = prereq.install?.options ?? [];
  const showInstallHelp =
    (!isInstalled || needsUpdate || !hasResult) &&
    (instructionList.length > 0 ||
      installOptions.length > 0 ||
      Boolean(prereq.install_url));

  return (
    <div className="flex flex-col gap-3 rounded-lg border-2 border-border bg-card/70 px-4 py-3 shadow-[var(--shadow-xs)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <StatusIcon className="h-4 w-4 text-foreground/70" />
          <span className="font-medium text-sm">{result?.name ?? prereq.name}</span>
        </div>
        <Badge variant={isInstalled ? "secondary" : "outline"}>
          {statusLabel}
        </Badge>
      </div>
      <div className="text-xs text-muted-foreground space-y-1">
        {(result?.required_version ?? prereq.version) && (
          <p>Required: v{result?.required_version ?? prereq.version}</p>
        )}
        {result?.current_version ? (
          <p>Detected: v{result.current_version}</p>
        ) : hasResult ? (
          <p>No version detected</p>
        ) : (
          <p>Prerequisite check not run yet</p>
        )}
      </div>

      {showInstallHelp ? (
        <div className="space-y-3 rounded-md border border-border/60 bg-muted/20 px-3 py-2">
          {instructionList.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-semibold text-foreground/80">
                Install notes
              </p>
              <ul className="list-disc pl-4 text-xs text-muted-foreground">
                {instructionList.map((instruction, index) => (
                  <li key={`${prereq.name}-instruction-${index}`}>
                    {instruction}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {installOptions.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-foreground/80">
                Install options
              </p>
              {installOptions.map((option, optionIndex) => (
                <div
                  key={`${prereq.name}-option-${option.name}-${optionIndex}`}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 bg-background/70 px-3 py-2"
                >
                  <div>
                    <p className="text-sm font-medium">{option.name}</p>
                    {option.description ? (
                      <p className="text-xs text-muted-foreground">
                        {option.description}
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground font-mono">
                        {option.command}
                      </p>
                    )}
                    {option.only_if ? (
                      <p className="text-[11px] text-muted-foreground">
                        Only if {option.only_if}
                      </p>
                    ) : null}
                  </div>
                  {onRunInstallOption ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onRunInstallOption(optionIndex)}
                      disabled={isOptionRunning?.(optionIndex)}
                    >
                      {isOptionRunning?.(optionIndex)
                        ? "Installing..."
                        : "Run"}
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          )}

          {prereq.install_url && onOpenInstallUrl ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenInstallUrl(prereq.install_url!)}
            >
              Open install page
            </Button>
          ) : null}
        </div>
      ) : null}

      {installMessage ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
          {installMessage}
        </div>
      ) : null}
      {installError ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {installError}
        </div>
      ) : null}
    </div>
  );
}
