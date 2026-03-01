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
  containerService,
  type ContainerDetails,
  type ContainerInfo,
  type LimaStatus,
} from "@/services/containerService";
import { backendService } from "@/services/backendService";
import { cn } from "@/lib/utils";

interface LimaContainersPanelProps {
  className?: string;
}

function statusLabel(installed: boolean): string {
  return installed ? "Ready" : "Needs setup";
}

function statusBadgeVariant(installed: boolean) {
  return installed ? "secondary" : "destructive";
}

function containerStateLabel(state: ContainerInfo["state"]) {
  if (state === "running") {
    return "Active";
  }
  if (state === "stopped") {
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

export function LimaContainersPanel({ className }: LimaContainersPanelProps) {
  const [limaStatus, setLimaStatus] = useState<LimaStatus | null>(null);
  const [limaChecking, setLimaChecking] = useState(true);
  const [limaError, setLimaError] = useState<string | null>(null);

  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [containersLoading, setContainersLoading] = useState(true);
  const [containersError, setContainersError] = useState<string | null>(null);
  const [containerAction, setContainerAction] = useState<Record<string, boolean>>({});
  const [manageOpen, setManageOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsContainer, setDetailsContainer] = useState<ContainerInfo | null>(
    null,
  );
  const [detailsData, setDetailsData] = useState<ContainerDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);

  const loadLimaStatus = useCallback(async () => {
    setLimaChecking(true);
    setLimaError(null);
    try {
      const status = await containerService.checkLimaInstalled();
      setLimaStatus(status);
    } catch (err) {
      setLimaError(`Failed to check support tools: ${String(err)}`);
      setLimaStatus(null);
    } finally {
      setLimaChecking(false);
    }
  }, []);

  const loadContainers = useCallback(async () => {
    setContainersLoading(true);
    setContainersError(null);
    try {
      const list = await containerService.listContainers();
      setContainers(list);
    } catch (err) {
      setContainersError(`Failed to load packaged projects: ${String(err)}`);
      setContainers([]);
    } finally {
      setContainersLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadLimaStatus();
    void loadContainers();
  }, [loadContainers, loadLimaStatus]);

  const fetchDetails = useCallback(async (target: ContainerInfo) => {
    setDetailsLoading(true);
    setDetailsError(null);
    try {
      const data = await containerService.getContainerDetails(
        target.id,
        target.vm,
        target.name,
      );
      setDetailsData(data);
    } catch (err) {
      setDetailsError(`Failed to load details: ${String(err)}`);
    } finally {
      setDetailsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!detailsOpen || !detailsContainer) {
      return;
    }
    void fetchDetails(detailsContainer);
  }, [detailsContainer, detailsOpen, fetchDetails]);

  const handleRefresh = async () => {
    await loadLimaStatus();
    await loadContainers();
  };

  const handleDetailsOpenChange = (open: boolean) => {
    setDetailsOpen(open);
    if (!open) {
      setDetailsContainer(null);
      setDetailsData(null);
      setDetailsError(null);
      setDetailsLoading(false);
    }
  };

  const handleOpenDetails = (container: ContainerInfo) => {
    setDetailsContainer(container);
    setDetailsData(null);
    setDetailsError(null);
    setDetailsOpen(true);
  };

  const handleManageOpenChange = (open: boolean) => {
    setManageOpen(open);
  };

  const groupedContainers = useMemo(() => {
    const map = new Map<string, ContainerInfo[]>();
    containers.forEach((container) => {
      const list = map.get(container.repo_path) ?? [];
      list.push(container);
      map.set(container.repo_path, list);
    });
    return Array.from(map.entries());
  }, [containers]);

  const containerSummary = useMemo(() => {
    const running = containers.filter(
      (container) => container.state === "running",
    ).length;
    const stopped = containers.filter(
      (container) => container.state === "stopped",
    ).length;
    const total = containers.length;
    const attention = Math.max(total - running - stopped, 0);
    const projects = new Set(
      containers.map((container) => container.repo_path),
    ).size;
    return {
      total,
      running,
      stopped,
      attention,
      projects,
    };
  }, [containers]);

  const handleContainerAction = async (
    container: ContainerInfo,
    action: "start" | "stop" | "delete",
  ) => {
    const key = `${container.id}:${action}`;
    setContainerAction((prev) => ({ ...prev, [key]: true }));
    setContainersError(null);
    try {
      if (action === "start") {
        await containerService.startContainer(
          container.id,
          container.vm,
          container.name,
        );
      } else if (action === "stop") {
        await containerService.stopContainer(
          container.id,
          container.vm,
          container.name,
        );
      } else {
        await containerService.deleteContainer(
          container.id,
          container.vm,
          container.name,
        );
      }
      await loadContainers();
    } catch (err) {
      setContainersError(`Project action failed: ${String(err)}`);
    } finally {
      setContainerAction((prev) => ({ ...prev, [key]: false }));
    }
  };

  const handleStartDetails = async () => {
    if (!detailsContainer) {
      return;
    }
    await handleContainerAction(detailsContainer, "start");
    await fetchDetails(detailsContainer);
  };

  const formatTimestamp = (value?: number | null) => {
    if (!value) {
      return "Unknown";
    }
    const date = new Date(value * 1000);
    if (Number.isNaN(date.getTime())) {
      return "Unknown";
    }
    return date.toLocaleString();
  };

  const installed = limaStatus?.installed ?? false;
  const statusLabelText = limaStatus ? statusLabel(limaStatus.installed) : "Checking";
  const detailsRepoName = detailsContainer?.repo_path
    ? repoLabel(detailsContainer.repo_path)
    : null;
  const detailState = ((detailsData?.state &&
    detailsData.state !== "unknown"
      ? detailsData.state
      : detailsContainer?.state) ?? "unknown") as ContainerInfo["state"];
  const detailMounts = detailsData?.mounts ?? [];
  const detailPorts = detailsData?.ports ?? [];
  const packageSummary =
    containerSummary.total > 0
      ? `${containerSummary.total} package${
          containerSummary.total === 1 ? "" : "s"
        } for ${containerSummary.projects} project${
          containerSummary.projects === 1 ? "" : "s"
        }`
      : "No packages yet.";
  const packageStateSummary =
    containerSummary.total > 0
      ? `Active: ${containerSummary.running} · Paused: ${containerSummary.stopped}`
      : null;

  return (
    <>
      <Card className={cn("border-border/60 bg-background/85", className)}>
        <CardHeader className="border-b border-border/60 pb-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="text-xl">Packaged projects</CardTitle>
              <CardDescription>
                Some projects run in their own package so everything works the
                same on every computer.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6 pt-6">
          <div className="rounded-lg border border-border/60 bg-background/60 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1 text-sm">
                <div className="font-semibold">System readiness</div>
                <div className="text-xs text-muted-foreground">
                  Keeps packaged projects running smoothly.
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={handleRefresh}
                  disabled={limaChecking || containersLoading}
                  className="normal-case tracking-normal"
                >
                  Refresh
                </Button>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant={statusBadgeVariant(installed)}>
                {limaChecking ? "Checking" : statusLabelText}
              </Badge>
            </div>
          </div>

          {limaError ? (
            <Alert variant="destructive">
              <AlertDescription>{limaError}</AlertDescription>
            </Alert>
          ) : null}

          <div className="rounded-lg border border-border/60 bg-background/60 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1 text-sm">
                <div className="font-semibold">Packages for your projects</div>
                <div className="text-xs text-muted-foreground">
                  {packageSummary}
                </div>
                {packageStateSummary ? (
                  <div className="text-xs text-muted-foreground">
                    {packageStateSummary}
                    {containerSummary.attention > 0
                      ? ` · Needs help: ${containerSummary.attention}`
                      : ""}
                  </div>
                ) : null}
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setManageOpen(true)}
                disabled={containersLoading}
                className="normal-case tracking-normal"
              >
                Manage packages
              </Button>
            </div>
            {!installed && !limaChecking ? (
              <div className="mt-2 text-xs text-destructive">
                System readiness needs attention.
              </div>
            ) : null}
          </div>

          {containersError ? (
            <Alert variant="destructive">
              <AlertDescription>{containersError}</AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      <Dialog open={manageOpen} onOpenChange={handleManageOpenChange}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Manage packages</DialogTitle>
            <DialogDescription>
              Start, pause, or remove packaged projects. Use details for
              advanced information.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <div className="text-muted-foreground">{packageSummary}</div>
              <Button
                size="sm"
                variant="outline"
                onClick={loadContainers}
                disabled={containersLoading}
                className="normal-case tracking-normal"
              >
                {containersLoading ? "Loading..." : "Refresh"}
              </Button>
            </div>

            {!installed ? (
              <div className="rounded-lg border border-dashed border-border/60 px-3 py-3 text-xs text-muted-foreground">
                Support tools are missing from this build. Reinstall Falck to
                restore them.
              </div>
            ) : containersLoading ? (
              <div className="rounded-lg border border-dashed border-border/60 px-3 py-3 text-xs text-muted-foreground">
                Loading packages...
              </div>
            ) : groupedContainers.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border/60 px-3 py-3 text-xs text-muted-foreground">
                No packages yet. They appear after you run a packaged project.
              </div>
            ) : (
              <div className="max-h-[55vh] overflow-y-auto pr-2">
                <div className="space-y-3">
                  {groupedContainers.map(([repoPath, repoContainers]) => {
                    const runningCount = repoContainers.filter(
                      (container) => container.state === "running",
                    ).length;
                    const stoppedCount = repoContainers.filter(
                      (container) => container.state === "stopped",
                    ).length;
                    const attentionCount = Math.max(
                      repoContainers.length - runningCount - stoppedCount,
                      0,
                    );

                    return (
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
                            {repoContainers.length} package
                            {repoContainers.length === 1 ? "" : "s"}
                            {runningCount > 0 ? ` · ${runningCount} running` : ""}
                            {stoppedCount > 0 ? ` · ${stoppedCount} stopped` : ""}
                            {attentionCount > 0
                              ? ` · ${attentionCount} need help`
                              : ""}
                          </div>
                        </div>
                        <div className="mt-4 space-y-2">
                          {repoContainers.map((container, containerIndex) => {
                            const running = container.state === "running";
                            const actionKey = `${container.id}:${
                              running ? "stop" : "start"
                            }`;
                            const deleteKey = `${container.id}:delete`;
                            const displayName = container.app_id
                              ? `App: ${container.app_id}`
                              : `Package ${containerIndex + 1}`;
                            return (
                              <div
                                key={container.id}
                                className="flex flex-col gap-2 rounded-lg border border-border/60 bg-background/80 p-3 sm:flex-row sm:items-center sm:justify-between"
                              >
                                <div className="space-y-1">
                                  <div className="text-sm font-medium">
                                    {displayName}
                                  </div>
                                  <div className="text-xs text-muted-foreground">
                                    {containerStateLabel(container.state)}
                                  </div>
                                </div>
                                <div className="flex flex-wrap items-center gap-2">
                                  <Button
                                    size="sm"
                                    variant={running ? "default" : "outline"}
                                    onClick={() =>
                                      void handleContainerAction(
                                        container,
                                        running ? "stop" : "start",
                                      )
                                    }
                                    disabled={containerAction[actionKey]}
                                    className="normal-case tracking-normal"
                                  >
                                    {running ? "Stop" : "Start"}
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() =>
                                      void handleContainerAction(
                                        container,
                                        "delete",
                                      )
                                    }
                                    disabled={containerAction[deleteKey]}
                                    className="normal-case tracking-normal"
                                  >
                                    Remove
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => handleOpenDetails(container)}
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
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={detailsOpen} onOpenChange={handleDetailsOpenChange}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Package details</DialogTitle>
            <DialogDescription>
              Full technical info for this packaged project.
            </DialogDescription>
          </DialogHeader>
          {!detailsContainer ? (
            <div className="text-sm text-muted-foreground">
              Select a package to see details.
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
              {detailsData?.inspect_error ? (
                <Alert variant="destructive">
                  <AlertDescription>{detailsData.inspect_error}</AlertDescription>
                </Alert>
              ) : null}
              {detailState !== "running" ? (
                <div className="rounded-lg border border-border/60 bg-background/60 px-3 py-2 text-xs text-muted-foreground">
                  Details are limited while the package is stopped. Start the
                  package to load full details.
                </div>
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
                    {containerStateLabel(detailState)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Package name</div>
                  <div className="text-xs font-mono break-all">
                    {detailsContainer.name}
                  </div>
                </div>
                {detailsContainer.app_id ? (
                  <div>
                    <div className="text-xs text-muted-foreground">App ID</div>
                    <div className="text-sm font-medium">
                      {detailsContainer.app_id}
                    </div>
                  </div>
                ) : null}
                <div>
                  <div className="text-xs text-muted-foreground">Package ID</div>
                  <div className="text-xs font-mono break-all">
                    {detailsContainer.id}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Workspace</div>
                  <div className="text-sm font-medium">
                    {detailsContainer.vm}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Image</div>
                  <div className="text-xs font-mono break-all">
                    {detailsContainer.image ?? "Not available"}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">
                    Project folder
                  </div>
                  <div className="text-xs font-mono break-all">
                    {detailsContainer.repo_path}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">
                    Last used
                  </div>
                  <div className="text-sm font-medium">
                    {formatTimestamp(detailsContainer.last_used)}
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-sm font-semibold">Mounts</div>
                {detailMounts.length > 0 ? (
                  <div className="space-y-2">
                    {detailMounts.map((mount, index) => (
                      <div
                        key={`${mount.source ?? "mount"}-${index}`}
                        className="rounded-lg border border-border/60 bg-background/60 p-3 text-xs"
                      >
                        <div className="text-muted-foreground">From</div>
                        <div className="font-mono break-all">
                          {mount.source ?? "Unknown"}
                        </div>
                        <div className="mt-2 text-muted-foreground">To</div>
                        <div className="font-mono break-all">
                          {mount.destination ?? "Unknown"}
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
                        key={`${port.host_port ?? "host"}-${port.container_port ?? "container"}-${index}`}
                        className="rounded-lg border border-border/60 bg-background/60 px-3 py-2 text-xs"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-muted-foreground">
                            Computer
                          </span>
                          <span className="font-mono">
                            {port.host_port ?? "?"}
                          </span>
                          <span className="text-muted-foreground">→</span>
                          <span className="text-muted-foreground">
                            Package
                          </span>
                          <span className="font-mono">
                            {port.container_port ?? "?"}
                            {port.protocol ? `/${port.protocol}` : ""}
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

              <details className="rounded-lg border border-border/60 bg-background/60 p-3 text-xs">
                <summary className="cursor-pointer font-semibold">
                  Environment and folders
                </summary>
                <div className="mt-2 space-y-2 text-xs">
                  <div>
                    <div className="text-muted-foreground">Working folder</div>
                    <div className="font-mono break-all">
                      {detailsData?.workdir ?? "Not available"}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Created</div>
                    <div className="font-mono break-all">
                      {detailsData?.created ?? "Not available"}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Environment</div>
                    {detailsData?.env?.length ? (
                      <div className="mt-1 rounded-md border border-border/60 bg-muted/20 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
                        {detailsData.env.join("\n")}
                      </div>
                    ) : (
                      <div className="font-mono">Not available</div>
                    )}
                  </div>
                </div>
              </details>

              <div className="flex flex-wrap justify-end gap-2">
                {detailState !== "running" ? (
                  <Button
                    variant="outline"
                    onClick={() => void handleStartDetails()}
                    disabled={
                      detailsLoading ||
                      containerAction[`${detailsContainer.id}:start`]
                    }
                    className="normal-case tracking-normal"
                  >
                    Start package to load details
                  </Button>
                ) : null}
                {detailsContainer.repo_path ? (
                  <Button
                    variant="outline"
                    onClick={() =>
                      backendService.openVmShell(detailsContainer.repo_path)
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
