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
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  containerService,
  type ContainerInfo,
  type LimaStatus,
} from "@/services/containerService";
import { cn } from "@/lib/utils";

interface LimaContainersPanelProps {
  className?: string;
}

function statusLabel(installed: boolean): string {
  return installed ? "Installed" : "Not installed";
}

function statusBadgeVariant(installed: boolean) {
  return installed ? "secondary" : "destructive";
}

function containerBadgeVariant(state: ContainerInfo["state"]) {
  switch (state) {
    case "running":
      return "secondary" as const;
    case "stopped":
      return "outline" as const;
    default:
      return "destructive" as const;
  }
}

function containerStateLabel(state: ContainerInfo["state"]) {
  if (state === "running") {
    return "Running";
  }
  if (state === "stopped") {
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

export function LimaContainersPanel({ className }: LimaContainersPanelProps) {
  const [limaStatus, setLimaStatus] = useState<LimaStatus | null>(null);
  const [limaChecking, setLimaChecking] = useState(true);
  const [limaInstalling, setLimaInstalling] = useState(false);
  const [limaError, setLimaError] = useState<string | null>(null);

  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [containersLoading, setContainersLoading] = useState(true);
  const [containersError, setContainersError] = useState<string | null>(null);
  const [containerAction, setContainerAction] = useState<Record<string, boolean>>({});

  const loadLimaStatus = useCallback(async () => {
    setLimaChecking(true);
    setLimaError(null);
    try {
      const status = await containerService.checkLimaInstalled();
      setLimaStatus(status);
    } catch (err) {
      setLimaError(`Failed to check Lima: ${String(err)}`);
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
      setContainersError(`Failed to load containers: ${String(err)}`);
      setContainers([]);
    } finally {
      setContainersLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadLimaStatus();
    void loadContainers();
  }, [loadContainers, loadLimaStatus]);

  const handleInstall = async () => {
    setLimaInstalling(true);
    setLimaError(null);
    try {
      await containerService.installLima();
      await loadLimaStatus();
      await loadContainers();
    } catch (err) {
      setLimaError(`Lima install failed: ${String(err)}`);
    } finally {
      setLimaInstalling(false);
    }
  };

  const handleRefresh = async () => {
    await loadLimaStatus();
    await loadContainers();
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
      setContainersError(`Container action failed: ${String(err)}`);
    } finally {
      setContainerAction((prev) => ({ ...prev, [key]: false }));
    }
  };

  const installed = limaStatus?.installed ?? false;
  const statusLabelText = limaStatus ? statusLabel(limaStatus.installed) : "Checking";

  return (
    <Card className={cn("border-border/60 bg-background/85", className)}>
      <CardHeader className="border-b border-border/60 pb-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-xl">Containers</CardTitle>
            <CardDescription>
              Some projects run inside containers. Falck sets them up only when
              needed.
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
            You only need this if a project asks for containers. Falck will
            prompt you when that happens.
          </AlertDescription>
        </Alert>

        <div className="rounded-lg border border-border/60 bg-background/60 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1 text-sm">
              <div className="font-semibold">Container helper (Lima)</div>
              <div className="text-xs text-muted-foreground">
                Install only when a project needs containers.
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {!installed ? (
                <Button
                  onClick={handleInstall}
                  disabled={limaInstalling}
                  className="normal-case tracking-normal"
                >
                  {limaInstalling ? "Installing..." : "Install Lima"}
                </Button>
              ) : null}
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
          {limaStatus?.version || limaStatus?.path ? (
            <details className="mt-2 text-xs text-muted-foreground">
              <summary className="cursor-pointer">Technical details</summary>
              {limaStatus?.version ? (
                <div className="mt-1">Version: {limaStatus.version}</div>
              ) : null}
              {limaStatus?.path ? (
                <div className="mt-1 font-mono break-all">
                  Location: {limaStatus.path}
                </div>
              ) : null}
            </details>
          ) : null}
        </div>

        {limaError ? (
          <Alert variant="destructive">
            <AlertDescription>{limaError}</AlertDescription>
          </Alert>
        ) : null}

        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <div className="text-sm font-semibold">Containers</div>
              <div className="text-xs text-muted-foreground">
                {containerSummary.projects > 0
                  ? `${containerSummary.projects} project${
                      containerSummary.projects === 1 ? "" : "s"
                    }`
                  : "No projects yet."}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{containerSummary.total} total</Badge>
              <Badge variant="secondary">{containerSummary.running} running</Badge>
              <Badge variant="outline">{containerSummary.stopped} stopped</Badge>
              {containerSummary.attention > 0 ? (
                <Badge variant="destructive">
                  {containerSummary.attention} needs attention
                </Badge>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                onClick={loadContainers}
                disabled={containersLoading}
                className="normal-case tracking-normal"
              >
                {containersLoading ? "Loading..." : "Reload"}
              </Button>
            </div>
          </div>

          {!installed ? (
            <div className="rounded-lg border border-dashed border-border/60 px-3 py-3 text-xs text-muted-foreground">
              Install the container helper to run container-based projects.
            </div>
          ) : containersLoading ? (
            <div className="rounded-lg border border-dashed border-border/60 px-3 py-3 text-xs text-muted-foreground">
              Loading containers...
            </div>
          ) : groupedContainers.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/60 px-3 py-3 text-xs text-muted-foreground">
              No containers yet. They appear after you run a container-based
              project.
            </div>
          ) : (
            <ScrollArea className="max-h-[420px] pr-2">
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
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="space-y-1">
                          <div className="text-sm font-semibold">
                            {repoLabel(repoPath)}
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
                            {repoContainers.length} container
                            {repoContainers.length === 1 ? "" : "s"}
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
                        {repoContainers.map((container) => {
                          const running = container.state === "running";
                          const actionKey = `${container.id}:${
                            running ? "stop" : "start"
                          }`;
                          const deleteKey = `${container.id}:delete`;
                          return (
                            <div
                              key={container.id}
                              className="flex flex-col gap-2 rounded-lg border border-border/60 bg-background/80 p-3 sm:flex-row sm:items-center sm:justify-between"
                            >
                              <div className="space-y-1">
                                <div className="text-sm font-medium">
                                  {container.name}
                                </div>
                                {container.app_id ? (
                                  <div className="text-xs text-muted-foreground">
                                    App: {container.app_id}
                                  </div>
                                ) : null}
                                <details className="text-xs text-muted-foreground">
                                  <summary className="cursor-pointer">
                                    Technical details
                                  </summary>
                                  <div className="mt-1">
                                    Workspace: {container.vm}
                                  </div>
                                  {container.image ? (
                                    <div className="mt-1">
                                      Image: {container.image}
                                    </div>
                                  ) : null}
                                  {container.status ? (
                                    <div className="mt-1">
                                      Status: {container.status}
                                    </div>
                                  ) : null}
                                </details>
                              </div>
                              <div className="flex flex-wrap items-center gap-2">
                                <Badge
                                  variant={containerBadgeVariant(container.state)}
                                >
                                  {containerStateLabel(container.state)}
                                </Badge>
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

          {containersError ? (
            <Alert variant="destructive">
              <AlertDescription>{containersError}</AlertDescription>
            </Alert>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
