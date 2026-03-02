import type { UpdateState } from "@/lib/updates";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Loader } from "@/components/ai-elements/loader";

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  const safeBytes = Math.max(bytes, 0);
  const unitIndex = Math.min(
    units.length - 1,
    Math.floor(Math.log(safeBytes) / Math.log(1024)),
  );
  const value = safeBytes / 1024 ** unitIndex;
  const formatted =
    unitIndex === 0 || value >= 10 ? value.toFixed(0) : value.toFixed(1);

  return `${formatted} ${units[unitIndex]}`;
};

export function UpdateProgressOverlay({ state }: { state: UpdateState }) {
  const isVisible =
    state.phase === "downloading" ||
    state.phase === "installing" ||
    state.phase === "restarting";

  if (!isVisible) {
    return null;
  }

  const percent =
    typeof state.progress?.percent === "number" &&
    Number.isFinite(state.progress.percent)
      ? state.progress.percent
      : undefined;
  const downloaded = state.progress?.downloaded ?? 0;
  const total = state.progress?.total;
  const hasTotal = typeof total === "number" && total > 0;
  const bytesLabel =
    state.phase === "downloading" && (downloaded > 0 || hasTotal)
      ? hasTotal
        ? `${formatBytes(downloaded)} / ${formatBytes(total)}`
        : formatBytes(downloaded)
      : null;

  const statusLabel =
    state.phase === "downloading"
      ? "Downloading update"
      : state.phase === "installing"
        ? "Installing update"
        : "Restarting Falck";
  const badgeLabel =
    state.phase === "downloading"
      ? "Downloading"
      : state.phase === "installing"
        ? "Installing"
        : "Restarting";

  return (
    <div
      className="fixed bottom-6 right-6 z-50 w-[320px] max-w-[calc(100vw-3rem)] rounded-2xl border border-border/60 bg-background/90 p-4 shadow-[0_20px_60px_rgba(15,23,42,0.2)] backdrop-blur"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-full border border-sky-500/30 bg-sky-500/10 text-sky-600">
          <Loader size={14} />
        </div>
        <div className="flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-foreground">
              {statusLabel}
            </span>
            <Badge variant="secondary" className="text-[0.65rem]">
              {badgeLabel}
            </Badge>
          </div>

          {state.version && (
            <div className="text-xs text-muted-foreground">
              Version {state.version}
            </div>
          )}

          {state.phase === "downloading" ? (
            percent !== undefined ? (
              <div className="space-y-1.5">
                <Progress value={percent} />
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{percent}%</span>
                  {bytesLabel ? <span>{bytesLabel}</span> : <span />}
                </div>
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">
                Starting download...
              </div>
            )
          ) : state.phase === "installing" ? (
            <div className="text-xs text-muted-foreground">
              Applying update files...
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              Restarting with the latest update...
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
