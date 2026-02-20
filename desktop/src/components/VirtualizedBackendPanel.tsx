import { useCallback, useEffect, useMemo, useState } from "react";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  backendService,
  type BackendMode,
  type BackendPrereqStatus,
  type BackendVmInfo,
} from "@/services/backendService";
import { cn } from "@/lib/utils";

interface VirtualizedBackendPanelProps {
  className?: string;
}

const MODE_LABELS: Record<BackendMode, string> = {
  host: "On this computer",
  virtualized: "In a virtual workspace",
};

function normalizeStatus(status: string) {
  const normalized = status.toLowerCase();
  if (normalized === "running") {
    return "running";
  }
  if (normalized === "stopped") {
    return "stopped";
  }
  return "unknown";
}

function statusBadgeVariant(status: string) {
  const normalized = normalizeStatus(status);
  if (normalized === "running") {
    return "secondary" as const;
  }
  if (normalized === "stopped") {
    return "outline" as const;
  }
  return "destructive" as const;
}

function vmStatusLabel(status: string) {
  const normalized = normalizeStatus(status);
  if (normalized === "running") {
    return "Running";
  }
  if (normalized === "stopped") {
    return "Stopped";
  }
  return "Needs attention";
}

function repoLabel(path: string) {
  const cleaned = path.trim();
  if (!cleaned) {
    return "Unknown repo";
  }
  const parts = cleaned.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? cleaned;
}

export function VirtualizedBackendPanel({
  className,
}: VirtualizedBackendPanelProps) {
  const [mode, setMode] = useState<BackendMode>("host");
  const [modeSaving, setModeSaving] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);

  const [prereq, setPrereq] = useState<BackendPrereqStatus | null>(null);
  const [prereqLoading, setPrereqLoading] = useState(true);
  const [prereqError, setPrereqError] = useState<string | null>(null);
  const [prereqInstalling, setPrereqInstalling] = useState(false);

  const [vms, setVms] = useState<BackendVmInfo[]>([]);
  const [vmsLoading, setVmsLoading] = useState(true);
  const [vmsError, setVmsError] = useState<string | null>(null);
  const [vmAction, setVmAction] = useState<Record<string, boolean>>({});

  const loadMode = useCallback(async () => {
    setModeError(null);
    try {
      const nextMode = await backendService.getMode();
      setMode(nextMode);
    } catch (err) {
      setModeError(`Failed to load backend mode: ${String(err)}`);
    }
  }, []);

  const loadPrereq = useCallback(async () => {
    setPrereqLoading(true);
    setPrereqError(null);
    try {
      const status = await backendService.checkPrereq();
      setPrereq(status);
    } catch (err) {
      setPrereqError(`Failed to check virtualized backend: ${String(err)}`);
      setPrereq(null);
    } finally {
      setPrereqLoading(false);
    }
  }, []);

  const loadVms = useCallback(async () => {
    setVmsLoading(true);
    setVmsError(null);
    try {
      const list = await backendService.listVms();
      setVms(list);
    } catch (err) {
      setVmsError(`Failed to load VMs: ${String(err)}`);
      setVms([]);
    } finally {
      setVmsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMode();
    void loadPrereq();
    void loadVms();
  }, [loadMode, loadPrereq, loadVms]);

  const handleModeChange = async (nextMode: BackendMode) => {
    setModeSaving(true);
    setModeError(null);
    const previous = mode;
    setMode(nextMode);
    try {
      await backendService.setMode(nextMode);
    } catch (err) {
      setMode(previous);
      setModeError(`Failed to update backend mode: ${String(err)}`);
    } finally {
      setModeSaving(false);
    }
  };

  const handleInstallPrereq = async () => {
    setPrereqInstalling(true);
    setPrereqError(null);
    try {
      await backendService.installPrereq();
      await loadPrereq();
      await loadVms();
    } catch (err) {
      setPrereqError(`Install failed: ${String(err)}`);
    } finally {
      setPrereqInstalling(false);
    }
  };

  const handleVmAction = async (
    vm: BackendVmInfo,
    action: "start" | "stop" | "delete",
  ) => {
    const key = `${vm.name}:${action}`;
    setVmAction((prev) => ({ ...prev, [key]: true }));
    setVmsError(null);
    try {
      if (action === "start") {
        if (vm.repo_path) {
          await backendService.ensureRepoBackend(vm.repo_path);
        }
      } else if (action === "stop") {
        await backendService.stopVm(vm.name);
      } else {
        await backendService.deleteVm(vm.name);
      }
      await loadVms();
    } catch (err) {
      setVmsError(`VM action failed: ${String(err)}`);
    } finally {
      setVmAction((prev) => ({ ...prev, [key]: false }));
    }
  };

  const groupedVms = useMemo(() => {
    const map = new Map<string, BackendVmInfo[]>();
    vms.forEach((vm) => {
      const key = vm.repo_path ?? "";
      const list = map.get(key) ?? [];
      list.push(vm);
      map.set(key, list);
    });
    return Array.from(map.entries());
  }, [vms]);

  const vmSummary = useMemo(() => {
    const running = vms.filter(
      (vm) => normalizeStatus(vm.status) === "running",
    ).length;
    const stopped = vms.filter(
      (vm) => normalizeStatus(vm.status) === "stopped",
    ).length;
    const total = vms.length;
    const attention = Math.max(total - running - stopped, 0);
    const projects = new Set(
      vms
        .map((vm) => vm.repo_path)
        .filter((path): path is string => Boolean(path)),
    ).size;
    return {
      total,
      running,
      stopped,
      attention,
      projects,
    };
  }, [vms]);

  const prereqInstalled = prereq?.installed ?? false;
  const toolLabel = prereq?.tool ?? "Virtualization";

  return (
    <Card className={cn("border-border/60 bg-background/85", className)}>
      <CardHeader className="border-b border-border/60 pb-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-xl">Virtualized apps</CardTitle>
            <CardDescription>
              Use a safe workspace when a project needs it. Most users can leave
              this alone.
            </CardDescription>
          </div>
          <Badge variant="outline" className="h-6">
            Optional
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-6 pt-6">
        <Alert className="border-border/60 bg-background/60">
          <AlertDescription>
            If you are not sure, keep the default. Falck will tell you when a
            project needs a virtual workspace.
          </AlertDescription>
        </Alert>

        <div className="flex flex-col gap-4">
          <div className="rounded-lg border border-border/60 bg-background/60 p-4">
            <div className="flex gap-3 flex-col">
              <div className="space-y-1 text-sm">
                <div className="font-semibold">Where apps run</div>
                <div className="text-xs text-muted-foreground">
                  Default is {MODE_LABELS.host}. Switch only if a project asks
                  for it.
                </div>
              </div>
              <Select
                value={mode}
                onValueChange={(value) =>
                  handleModeChange(value as BackendMode)
                }
                disabled={modeSaving}
              >
                <SelectTrigger className="w-[220px]">
                  <SelectValue placeholder="Select mode" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="host">{MODE_LABELS.host}</SelectItem>
                  <SelectItem value="virtualized">
                    {MODE_LABELS.virtualized}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            {modeSaving ? (
              <div className="mt-2 text-xs text-muted-foreground">
                Saving...
              </div>
            ) : null}
          </div>

          <div className="rounded-lg border border-border/60 bg-background/60 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1 text-sm">
                <div className="font-semibold">{toolLabel} helper</div>
                <div className="text-xs text-muted-foreground">
                  Install only when a project needs virtual workspaces.
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {!prereqInstalled ? (
                  <Button
                    onClick={handleInstallPrereq}
                    disabled={prereqInstalling}
                    className="normal-case tracking-normal"
                  >
                    {prereqInstalling
                      ? "Installing..."
                      : `Install ${toolLabel}`}
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  onClick={() => {
                    void loadPrereq();
                    void loadVms();
                    void loadMode();
                  }}
                  disabled={prereqLoading || vmsLoading}
                  className="normal-case tracking-normal"
                >
                  Refresh
                </Button>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant={prereqInstalled ? "secondary" : "destructive"}>
                {prereqLoading
                  ? "Checking"
                  : prereqInstalled
                    ? "Installed"
                    : "Not installed"}
              </Badge>
              {prereq?.message ? <span>{prereq.message}</span> : null}
            </div>
          </div>
        </div>

        {modeError ? (
          <Alert variant="destructive">
            <AlertDescription>{modeError}</AlertDescription>
          </Alert>
        ) : null}

        {prereqError ? (
          <Alert variant="destructive">
            <AlertDescription>{prereqError}</AlertDescription>
          </Alert>
        ) : null}

        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <div className="text-sm font-semibold">Virtual workspaces</div>
              <div className="text-xs text-muted-foreground">
                {vmSummary.projects > 0
                  ? `${vmSummary.projects} project${
                      vmSummary.projects === 1 ? "" : "s"
                    }`
                  : "No projects yet."}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{vmSummary.total} total</Badge>
              <Badge variant="secondary">{vmSummary.running} running</Badge>
              <Badge variant="outline">{vmSummary.stopped} stopped</Badge>
              {vmSummary.attention > 0 ? (
                <Badge variant="destructive">
                  {vmSummary.attention} needs attention
                </Badge>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                onClick={loadVms}
                disabled={vmsLoading}
                className="normal-case tracking-normal"
              >
                {vmsLoading ? "Loading..." : "Reload"}
              </Button>
            </div>
          </div>

          {!prereqInstalled ? (
            <div className="rounded-lg border border-dashed border-border/60 px-3 py-3 text-xs text-muted-foreground">
              Install the {toolLabel} helper to create virtual workspaces when a
              project needs them.
            </div>
          ) : vmsLoading ? (
            <div className="rounded-lg border border-dashed border-border/60 px-3 py-3 text-xs text-muted-foreground">
              Loading virtual workspaces...
            </div>
          ) : groupedVms.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/60 px-3 py-3 text-xs text-muted-foreground">
              No virtual workspaces yet. They appear after you run a project
              that needs them.
            </div>
          ) : (
            <ScrollArea className="max-h-[420px] pr-2">
              <div className="space-y-3">
                {groupedVms.map(([repoPath, repoVms]) => {
                  const runningCount = repoVms.filter(
                    (vm) => normalizeStatus(vm.status) === "running",
                  ).length;
                  const stoppedCount = repoVms.filter(
                    (vm) => normalizeStatus(vm.status) === "stopped",
                  ).length;
                  const attentionCount = Math.max(
                    repoVms.length - runningCount - stoppedCount,
                    0,
                  );

                  return (
                    <div
                      key={repoPath || "unknown"}
                      className="rounded-lg border border-border/60 bg-background/60 p-4"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="space-y-1">
                          <div className="text-sm font-semibold">
                            {repoPath
                              ? repoLabel(repoPath)
                              : "Unlinked project"}
                          </div>
                          {repoPath ? (
                            <details className="text-xs text-muted-foreground">
                              <summary className="cursor-pointer">
                                Show folder
                              </summary>
                              <div className="mt-1 font-mono break-all">
                                {repoPath}
                              </div>
                            </details>
                          ) : (
                            <div className="text-xs text-muted-foreground">
                              No project folder linked.
                            </div>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <Badge variant="outline">
                            {repoVms.length} workspace
                            {repoVms.length === 1 ? "" : "s"}
                          </Badge>
                          {runningCount > 0 ? (
                            <Badge variant="secondary">
                              {runningCount} running
                            </Badge>
                          ) : null}
                          {stoppedCount > 0 ? (
                            <Badge variant="outline">
                              {stoppedCount} stopped
                            </Badge>
                          ) : null}
                          {attentionCount > 0 ? (
                            <Badge variant="destructive">
                              {attentionCount} needs attention
                            </Badge>
                          ) : null}
                        </div>
                      </div>
                      <div className="mt-4 space-y-2">
                        {repoVms.map((vm) => {
                          const normalizedStatus = normalizeStatus(vm.status);
                          const running = normalizedStatus === "running";
                          return (
                            <div
                              key={vm.name}
                              className="flex flex-col gap-2 rounded-lg border border-border/60 bg-background/80 p-3 sm:flex-row sm:items-center sm:justify-between"
                            >
                              <div className="space-y-1 text-sm">
                                <div className="font-semibold">{vm.name}</div>
                                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                  <Badge
                                    variant={statusBadgeVariant(vm.status)}
                                  >
                                    {vmStatusLabel(vm.status)}
                                  </Badge>
                                  <span>Engine: {vm.provider}</span>
                                </div>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                {!running && vm.repo_path ? (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => handleVmAction(vm, "start")}
                                    disabled={vmAction[`${vm.name}:start`]}
                                    className="normal-case tracking-normal"
                                  >
                                    Start
                                  </Button>
                                ) : null}
                                {running ? (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => handleVmAction(vm, "stop")}
                                    disabled={vmAction[`${vm.name}:stop`]}
                                    className="normal-case tracking-normal"
                                  >
                                    Stop
                                  </Button>
                                ) : null}
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => handleVmAction(vm, "delete")}
                                  disabled={vmAction[`${vm.name}:delete`]}
                                  className="normal-case tracking-normal"
                                >
                                  Delete
                                </Button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          )}

          {vmsError ? (
            <Alert variant="destructive">
              <AlertDescription>{vmsError}</AlertDescription>
            </Alert>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
