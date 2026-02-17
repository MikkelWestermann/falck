import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useVmStatus } from "@/contexts/VmStatusContext";
import { AlertTriangle, CircleCheck, Loader2, Server } from "lucide-react";

const phaseLabels: Record<string, string> = {
  idle: "Idle",
  checking: "Checking prerequisites",
  starting: "Starting VM",
  creating: "Creating VM",
  waiting: "Waiting for VM",
  bootstrapping: "Bootstrapping",
  ready: "Ready",
  stopping: "Stopping VM",
  stopped: "Stopped",
  deleting: "Deleting VM",
  deleted: "Deleted",
  error: "Error",
};

function formatTime(timestampMs?: number) {
  if (!timestampMs) {
    return "";
  }
  return new Date(timestampMs).toLocaleTimeString();
}

export function VmStatusOverlay() {
  const { state, busy, expanded, setExpanded } = useVmStatus();

  if (!state.enabled) {
    return null;
  }

  const show = busy || expanded;
  if (!show) {
    return null;
  }

  const logs = expanded ? state.logs : state.logs.slice(-3);
  const isError = state.phase === "error";
  const isReady = state.phase === "ready";

  return (
    <div className="pointer-events-none fixed right-6 top-24 z-50 w-[380px] max-w-[calc(100%-3rem)]">
      <div className="pointer-events-auto overflow-hidden rounded-2xl border border-border/60 bg-card/95 shadow-[var(--shadow-lg)] backdrop-blur">
        <div className="flex items-start justify-between gap-4 px-4 py-3">
          <div className="flex items-start gap-3">
            <div
              className={cn(
                "mt-1 flex h-9 w-9 items-center justify-center rounded-full border",
                isError
                  ? "border-destructive/40 bg-destructive/10 text-destructive"
                  : busy
                    ? "border-amber-400/40 bg-amber-400/10 text-amber-600"
                    : isReady
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600"
                      : "border-border/60 bg-muted text-muted-foreground",
              )}
            >
              {isError ? (
                <AlertTriangle className="h-4 w-4" />
              ) : busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : isReady ? (
                <CircleCheck className="h-4 w-4" />
              ) : (
                <Server className="h-4 w-4" />
              )}
            </div>
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Virtualized backend
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-foreground">
                  {phaseLabels[state.phase] ?? "VM status"}
                </span>
                <Badge
                  variant={isError ? "destructive" : isReady ? "secondary" : "outline"}
                  className="text-[0.65rem]"
                >
                  {state.phase}
                </Badge>
              </div>
              {state.message && (
                <p className="text-xs text-muted-foreground">{state.message}</p>
              )}
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExpanded(!expanded)}
            className="h-8"
          >
            {expanded ? "Collapse" : "Details"}
          </Button>
        </div>

        <div className="border-t border-border/60 px-4 py-3">
          <ScrollArea className={expanded ? "max-h-64" : "max-h-24"}>
            {logs.length === 0 ? (
              <div className="text-xs text-muted-foreground">
                Waiting for VM activity...
              </div>
            ) : (
              <div className="space-y-2">
                {logs.map((entry, index) => (
                  <div
                    key={`${entry.timestamp_ms}-${index}`}
                    className="rounded-lg border border-border/60 bg-background/70 px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-2 text-[0.7rem] text-muted-foreground">
                      <span className="font-mono">{formatTime(entry.timestamp_ms)}</span>
                      <span className="uppercase tracking-wide">{entry.phase}</span>
                    </div>
                    <div className="mt-1 text-xs text-foreground">
                      {entry.message}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </div>

        {(state.vmName || state.provider) && (
          <div className="border-t border-border/60 px-4 py-2 text-[0.7rem] text-muted-foreground">
            {state.provider ? state.provider.toUpperCase() : "VM"}
            {state.vmName ? ` • ${state.vmName}` : ""}
          </div>
        )}
      </div>
    </div>
  );
}
