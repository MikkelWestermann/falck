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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  backendService,
  type BackendMode,
  type BackendPrereqStatus,
  type BackendVmDetails,
  type BackendVmInfo,
} from "@/services/backendService";
import { cn } from "@/lib/utils";

interface VirtualizedBackendPanelProps {
  className?: string;
}

const MODE_LABELS: Record<BackendMode, string> = {
  host: "On this computer",
  virtualized: "In a safe workspace",
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

function vmStatusLabel(status: string) {
  const normalized = normalizeStatus(status);
  if (normalized === "running") {
    return "Active";
  }
  if (normalized === "stopped") {
    return "Paused";
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

  const [vms, setVms] = useState<BackendVmInfo[]>([]);
  const [vmsLoading, setVmsLoading] = useState(true);
  const [vmsError, setVmsError] = useState<string | null>(null);
  const [vmAction, setVmAction] = useState<Record<string, boolean>>({});
  const [manageOpen, setManageOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsVm, setDetailsVm] = useState<BackendVmInfo | null>(null);
  const [detailsData, setDetailsData] = useState<BackendVmDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);

  const loadMode = useCallback(async () => {
    setModeError(null);
    try {
      const nextMode = await backendService.getMode();
      setMode(nextMode);
    } catch (err) {
      setModeError(`Failed to load workspace setting: ${String(err)}`);
    }
  }, []);

  const loadPrereq = useCallback(async () => {
    setPrereqLoading(true);
    setPrereqError(null);
    try {
      const status = await backendService.checkPrereq();
      setPrereq(status);
    } catch (err) {
      setPrereqError(`Failed to check workspace support: ${String(err)}`);
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
      setVmsError(`Failed to load workspaces: ${String(err)}`);
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

  useEffect(() => {
    if (!detailsOpen || !detailsVm) {
      return;
    }
    let active = true;
    setDetailsLoading(true);
    setDetailsError(null);
    backendService
      .getVmDetails(detailsVm.name)
      .then((data) => {
        if (!active) {
          return;
        }
        setDetailsData(data);
      })
      .catch((err) => {
        if (!active) {
          return;
        }
        setDetailsError(`Failed to load details: ${String(err)}`);
      })
      .finally(() => {
        if (!active) {
          return;
        }
        setDetailsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [detailsOpen, detailsVm]);

  const handleModeChange = async (nextMode: BackendMode) => {
    setModeSaving(true);
    setModeError(null);
    const previous = mode;
    setMode(nextMode);
    try {
      await backendService.setMode(nextMode);
    } catch (err) {
      setMode(previous);
      setModeError(`Failed to update workspace setting: ${String(err)}`);
    } finally {
      setModeSaving(false);
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
      setVmsError(`Workspace action failed: ${String(err)}`);
    } finally {
      setVmAction((prev) => ({ ...prev, [key]: false }));
    }
  };

  const handleDetailsOpenChange = (open: boolean) => {
    setDetailsOpen(open);
    if (!open) {
      setDetailsVm(null);
      setDetailsData(null);
      setDetailsError(null);
      setDetailsLoading(false);
    }
  };

  const handleOpenDetails = (vm: BackendVmInfo) => {
    setDetailsVm(vm);
    setDetailsData(null);
    setDetailsError(null);
    setDetailsOpen(true);
  };

  const handleManageOpenChange = (open: boolean) => {
    setManageOpen(open);
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
  const toolLabel = prereq?.tool ?? "Support tool";
  const detailsRepoName = detailsVm?.repo_path
    ? repoLabel(detailsVm.repo_path)
    : null;
  const detailRepoPath = detailsData?.repo_path ?? detailsVm?.repo_path ?? null;
  const detailRepoMount = detailsData?.repo_mount ?? null;
  const detailStatus = detailsData?.status ?? detailsVm?.status ?? "unknown";
  const detailMounts = detailsData?.mounts ?? [];
  const detailPorts = detailsData?.port_forwards ?? [];
  const workspaceSummary =
    vmSummary.total > 0
      ? `${vmSummary.total} workspace${
          vmSummary.total === 1 ? "" : "s"
        } for ${vmSummary.projects} project${vmSummary.projects === 1 ? "" : "s"}`
      : "No workspaces yet.";
  const workspaceStateSummary =
    vmSummary.total > 0
      ? `Active: ${vmSummary.running} · Paused: ${vmSummary.stopped}`
      : null;

  return (
    <>
      <Card className={cn("border-border/60 bg-background/85", className)}>
        <CardHeader className="border-b border-border/60 pb-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="text-xl">Safe workspaces</CardTitle>
              <CardDescription>
                Some projects need a separate workspace so they don't change
                your computer. Falck uses this only when needed.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6 pt-6">
          <div className="flex flex-col gap-4">
            <div className="rounded-lg border border-border/60 bg-background/60 p-4">
              <div className="flex flex-col gap-3">
                <div className="space-y-1 text-sm">
                  <div className="font-semibold">Default for new projects</div>
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
                  <div className="font-semibold">System readiness</div>
                  <div className="text-xs text-muted-foreground">
                    Keeps safe workspaces working when needed.
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
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
                      ? "Ready"
                      : "Needs setup"}
                </Badge>
                {!prereqInstalled && !prereqLoading ? (
                  <span>Support tools are missing.</span>
                ) : null}
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

          <div className="rounded-lg border border-border/60 bg-background/60 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1 text-sm">
                <div className="font-semibold">Workspaces for your projects</div>
                <div className="text-xs text-muted-foreground">
                  {workspaceSummary}
                </div>
                {workspaceStateSummary ? (
                  <div className="text-xs text-muted-foreground">
                    {workspaceStateSummary}
                    {vmSummary.attention > 0
                      ? ` · Needs help: ${vmSummary.attention}`
                      : ""}
                  </div>
                ) : null}
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setManageOpen(true)}
                disabled={vmsLoading}
                className="normal-case tracking-normal"
              >
                Manage workspaces
              </Button>
            </div>
            {!prereqInstalled && !prereqLoading ? (
              <div className="mt-2 text-xs text-destructive">
                System readiness needs attention.
              </div>
            ) : null}
          </div>

          {vmsError ? (
            <Alert variant="destructive">
              <AlertDescription>{vmsError}</AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      <Dialog open={manageOpen} onOpenChange={handleManageOpenChange}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Manage workspaces</DialogTitle>
            <DialogDescription>
              Start, pause, or remove safe workspaces. Use details for advanced
              information.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <div className="text-muted-foreground">{workspaceSummary}</div>
              <Button
                size="sm"
                variant="outline"
                onClick={loadVms}
                disabled={vmsLoading}
                className="normal-case tracking-normal"
              >
                {vmsLoading ? "Loading..." : "Refresh"}
              </Button>
            </div>

            {!prereqInstalled ? (
              <div className="rounded-lg border border-dashed border-border/60 px-3 py-3 text-xs text-muted-foreground">
                Support tools are missing from this build. Reinstall Falck to
                restore them.
              </div>
            ) : vmsLoading ? (
              <div className="rounded-lg border border-dashed border-border/60 px-3 py-3 text-xs text-muted-foreground">
                Loading workspaces...
              </div>
            ) : groupedVms.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border/60 px-3 py-3 text-xs text-muted-foreground">
                No workspaces yet. They appear after you run a project that
                needs them.
              </div>
            ) : (
              <div className="max-h-[55vh] overflow-y-auto pr-2">
                <div className="space-y-3">
                  {groupedVms.map(([repoPath, repoVms]) => (
                    <div
                      key={repoPath || "unknown"}
                      className="rounded-lg border border-border/60 bg-background/60 p-4"
                    >
                      <div className="space-y-1">
                        <div className="text-sm font-semibold">
                          {repoPath
                            ? repoLabel(repoPath)
                            : "Project not linked yet"}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {repoVms.length} workspace
                          {repoVms.length === 1 ? "" : "s"}
                        </div>
                      </div>
                      <div className="mt-4 space-y-2">
                        {repoVms.map((vm, vmIndex) => {
                          const normalizedStatus = normalizeStatus(vm.status);
                          const running = normalizedStatus === "running";
                          return (
                            <div
                              key={vm.name}
                              className="flex flex-col gap-2 rounded-lg border border-border/60 bg-background/80 p-3 sm:flex-row sm:items-center sm:justify-between"
                            >
                              <div className="space-y-1 text-sm">
                                <div className="font-semibold">
                                  Workspace {vmIndex + 1}
                                </div>
                                <div className="text-xs text-muted-foreground">
                                  {vmStatusLabel(vm.status)}
                                </div>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                {!running && vm.repo_path ? (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() =>
                                      handleVmAction(vm, "start")
                                    }
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
                                  variant="outline"
                                  onClick={() => handleVmAction(vm, "delete")}
                                  disabled={vmAction[`${vm.name}:delete`]}
                                  className="normal-case tracking-normal"
                                >
                                  Remove
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => handleOpenDetails(vm)}
                                  className="normal-case tracking-normal"
                                >
                                  See details
                                </Button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={detailsOpen} onOpenChange={handleDetailsOpenChange}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Workspace details</DialogTitle>
            <DialogDescription>
              Full technical info for this workspace.
            </DialogDescription>
          </DialogHeader>
          {!detailsVm ? (
            <div className="text-sm text-muted-foreground">
              Select a workspace to see details.
            </div>
          ) : (
            <div className="space-y-4">
              {detailsLoading ? (
                <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                  Loading details...
                </div>
              ) : null}
              {detailsError ? (
                <Alert variant="destructive">
                  <AlertDescription>{detailsError}</AlertDescription>
                </Alert>
              ) : null}

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <div className="text-xs text-muted-foreground">Project</div>
                  <div className="text-sm font-medium">
                    {detailsRepoName ?? "Unknown project"}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Status</div>
                  <div className="text-sm font-medium">
                    {vmStatusLabel(detailStatus)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">
                    Workspace name
                  </div>
                  <div className="text-xs font-mono break-all">
                    {detailsVm.name}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Provider</div>
                  <div className="text-sm font-medium">
                    {detailsData?.provider ?? detailsVm.provider}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">
                    Support tool
                  </div>
                  <div className="text-sm font-medium">{toolLabel}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">
                    Project folder
                  </div>
                  <div className="text-xs font-mono break-all">
                    {detailRepoPath ?? "Not linked"}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">
                    Workspace folder
                  </div>
                  <div className="text-xs font-mono break-all">
                    {detailRepoMount ?? "Not available"}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">
                    Config file
                  </div>
                  <div className="text-xs font-mono break-all">
                    {detailsData?.config_path ?? "Not available"}
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-sm font-semibold">Mounts</div>
                {detailMounts.length > 0 ? (
                  <div className="space-y-2">
                    {detailMounts.map((mount, index) => (
                      <div
                        key={`${mount.location ?? "mount"}-${index}`}
                        className="rounded-lg border border-border/60 bg-background/60 p-3 text-xs"
                      >
                        <div className="text-muted-foreground">From</div>
                        <div className="font-mono break-all">
                          {mount.location ?? "Unknown"}
                        </div>
                        <div className="mt-2 text-muted-foreground">To</div>
                        <div className="font-mono break-all">
                          {mount.mount_point ?? "Unknown"}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed border-border/60 px-3 py-2 text-xs text-muted-foreground">
                    No mount details available.
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <div className="text-sm font-semibold">Ports</div>
                {detailPorts.length > 0 ? (
                  <div className="space-y-2">
                    {detailPorts.map((port, index) => (
                      <div
                        key={`${port.host_port ?? "host"}-${port.guest_port ?? "guest"}-${index}`}
                        className="rounded-lg border border-border/60 bg-background/60 px-3 py-2 text-xs"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-muted-foreground">
                            Computer
                          </span>
                          <span className="font-mono">
                            {port.host_port ?? port.guest_port ?? "?"}
                          </span>
                          <span className="text-muted-foreground">→</span>
                          <span className="text-muted-foreground">
                            Workspace
                          </span>
                          <span className="font-mono">
                            {port.guest_port ?? port.host_port ?? "?"}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed border-border/60 px-3 py-2 text-xs text-muted-foreground">
                    No port forwards configured.
                  </div>
                )}
              </div>

              <div className="flex flex-wrap justify-end gap-2">
                {detailRepoPath ? (
                  <Button
                    variant="outline"
                    onClick={() =>
                      backendService.openVmShell(detailRepoPath)
                    }
                    className="normal-case tracking-normal"
                  >
                    Open workspace terminal
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  onClick={() => handleDetailsOpenChange(false)}
                  className="normal-case tracking-normal"
                >
                  Close
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
