import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useVmStatus } from "@/contexts/VmStatusContext";

export function VmStatusIndicator() {
  const { state, busy, setExpanded } = useVmStatus();

  if (!state.enabled) {
    return null;
  }

  const isError = state.phase === "error";
  const isReady = state.phase === "ready";
  const dotClass = isError
    ? "bg-destructive"
    : busy
      ? "bg-amber-400 animate-pulse"
      : isReady
        ? "bg-emerald-400"
        : "bg-muted-foreground/50";

  const label = isError
    ? "VM error"
    : busy
      ? "VM busy"
      : isReady
        ? "VM ready"
        : "VM";

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => setExpanded(true)}
      className="gap-2"
      title={state.message || label}
    >
      <span className={cn("h-2.5 w-2.5 rounded-full", dotClass)} />
      <span className="text-xs font-medium">VM</span>
    </Button>
  );
}
