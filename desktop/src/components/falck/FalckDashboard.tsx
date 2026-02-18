import { useEffect, useMemo, useRef, useState } from "react";
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
import {
  AlertCircle,
  CheckCircle2,
  ListChecks,
  Play,
  RefreshCw,
  Square,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  falckService,
  FalckApplication,
  FalckConfig,
  PrerequisiteCheckResult,
} from "@/services/falckService";
import { backendService, type BackendMode } from "@/services/backendService";
import { PrerequisiteStatus } from "@/components/falck/PrerequisiteStatus";
import { SecretsDialog } from "@/components/falck/SecretsDialog";
import { ScrollArea } from "@/components/ui/scroll-area";

interface FalckDashboardProps {
  repoPath: string;
  onActiveAppChange?: (app: FalckApplication | null) => void;
}

type SetupStatus =
  | "unknown"
  | "checking"
  | "complete"
  | "incomplete"
  | "not_configured"
  | "error";

export function FalckDashboard({
  repoPath,
  onActiveAppChange,
}: FalckDashboardProps) {
  const [config, setConfig] = useState<FalckConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeAppId, setActiveAppId] = useState<string | null>(null);
  const [prereqResults, setPrereqResults] = useState<
    Record<string, PrerequisiteCheckResult[]>
  >({});
  const [prereqLoading, setPrereqLoading] = useState<Record<string, boolean>>(
    {},
  );
  const [setupRunning, setSetupRunning] = useState<Record<string, boolean>>({});
  const [setupMessage, setSetupMessage] = useState<Record<string, string>>({});
  const [setupError, setSetupError] = useState<Record<string, string>>({});
  const [setupStatusByApp, setSetupStatusByApp] = useState<
    Record<string, SetupStatus>
  >({});
  const [setupStatusMessage, setSetupStatusMessage] = useState<
    Record<string, string>
  >({});
  const [launchError, setLaunchError] = useState<Record<string, string>>({});
  const [backendMode, setBackendMode] = useState<BackendMode | null>(null);
  const [runningApps, setRunningApps] = useState<Record<string, number>>({});
  const runningAppsRef = useRef<Record<string, number>>({});
  const [setupDialogOpen, setSetupDialogOpen] = useState(false);
  const [secretsSatisfied, setSecretsSatisfied] = useState<
    Record<string, boolean>
  >({});
  const [secretsDialogApp, setSecretsDialogApp] =
    useState<FalckApplication | null>(null);
  const [prereqInstallRunning, setPrereqInstallRunning] = useState<
    Record<string, boolean>
  >({});
  const [prereqInstallMessage, setPrereqInstallMessage] = useState<
    Record<string, string>
  >({});
  const [prereqInstallError, setPrereqInstallError] = useState<
    Record<string, string>
  >({});

  useEffect(() => {
    void loadConfig();
  }, [repoPath]);

  useEffect(() => {
    runningAppsRef.current = runningApps;
  }, [runningApps]);

  useEffect(() => {
    setRunningApps({});
    setLaunchError({});
  }, [repoPath]);

  useEffect(() => {
    return () => {
      const pids = Object.values(runningAppsRef.current);
      if (pids.length === 0) {
        return;
      }
      pids.forEach((pid) => {
        void falckService.killApp(pid);
      });
    };
  }, [repoPath]);

  const loadConfig = async () => {
    setLoading(true);
    setError(null);
    try {
      const nextConfig = await falckService.loadConfig(repoPath);
      setConfig(nextConfig);
      const nextDefault = nextConfig.applications[0]?.id ?? null;
      if (
        nextDefault &&
        (!activeAppId ||
          !nextConfig.applications.some((app) => app.id === activeAppId))
      ) {
        setActiveAppId(nextDefault);
      }
    } catch (err) {
      setConfig(null);
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!config) {
      return;
    }
    if (!backendMode) {
      return;
    }
    config.applications.forEach((app) => {
      const skipChecks =
        backendMode === "virtualized" && Boolean(app.launch.dockerfile);
      if (!skipChecks) {
        void checkPrereqs(app.id);
        void checkSetupStatus(app.id);
      }
      if (app.secrets && app.secrets.length > 0) {
        void checkSecrets(app.id);
      } else {
        setSecretsSatisfied((prev) => ({ ...prev, [app.id]: true }));
      }
    });
  }, [config, backendMode]);

  useEffect(() => {
    let active = true;
    backendService
      .getMode()
      .then((mode) => {
        if (active) {
          setBackendMode(mode);
        }
      })
      .catch(() => {
        if (active) {
          setBackendMode("host");
        }
      });
    return () => {
      active = false;
    };
  }, [repoPath]);

  const activeApp = useMemo(
    () =>
      config?.applications.find((app) => app.id === activeAppId) ??
      config?.applications[0] ??
      null,
    [config, activeAppId],
  );

  useEffect(() => {
    onActiveAppChange?.(activeApp);
  }, [activeApp, onActiveAppChange]);

  const checkPrereqs = async (appId: string) => {
    setPrereqLoading((prev) => ({ ...prev, [appId]: true }));
    try {
      const results = await falckService.checkPrerequisites(repoPath, appId);
      setPrereqResults((prev) => ({ ...prev, [appId]: results }));
    } catch (err) {
      setPrereqResults((prev) => ({ ...prev, [appId]: [] }));
      setError(`Failed to check prerequisites: ${String(err)}`);
    } finally {
      setPrereqLoading((prev) => ({ ...prev, [appId]: false }));
    }
  };

  const checkSetupStatus = async (appId: string) => {
    const app = config?.applications.find(
      (candidate) => candidate.id === appId,
    );
    if (!app?.setup?.check?.command) {
      setSetupStatusByApp((prev) => ({
        ...prev,
        [appId]: "not_configured",
      }));
      setSetupStatusMessage((prev) => ({ ...prev, [appId]: "" }));
      return;
    }

    setSetupStatusByApp((prev) => ({ ...prev, [appId]: "checking" }));
    setSetupStatusMessage((prev) => ({ ...prev, [appId]: "" }));
    try {
      const result = await falckService.checkSetupStatus(repoPath, appId);
      const status = result.configured
        ? result.complete
          ? "complete"
          : "incomplete"
        : "not_configured";
      setSetupStatusByApp((prev) => ({ ...prev, [appId]: status }));
      setSetupStatusMessage((prev) => ({
        ...prev,
        [appId]: result.message ?? "",
      }));
    } catch (err) {
      setSetupStatusByApp((prev) => ({ ...prev, [appId]: "error" }));
      setSetupStatusMessage((prev) => ({
        ...prev,
        [appId]: String(err),
      }));
    }
  };

  const checkSecrets = async (appId: string) => {
    try {
      const satisfied = await falckService.checkSecretsSatisfied(
        repoPath,
        appId,
      );
      setSecretsSatisfied((prev) => ({ ...prev, [appId]: satisfied }));
    } catch (err) {
      setSecretsSatisfied((prev) => ({ ...prev, [appId]: false }));
      setError(`Failed to check secrets: ${String(err)}`);
    }
  };

  const handleSetup = async (app: FalckApplication) => {
    setSetupRunning((prev) => ({ ...prev, [app.id]: true }));
    setSetupError((prev) => ({ ...prev, [app.id]: "" }));
    setSetupMessage((prev) => ({ ...prev, [app.id]: "" }));
    try {
      const message = await falckService.runSetup(repoPath, app.id);
      setSetupMessage((prev) => ({ ...prev, [app.id]: message }));
    } catch (err) {
      setSetupError((prev) => ({ ...prev, [app.id]: String(err) }));
    } finally {
      setSetupRunning((prev) => ({ ...prev, [app.id]: false }));
      void checkSetupStatus(app.id);
    }
  };

  const handlePrereqInstall = async (
    appId: string,
    prereqIndex: number,
    optionIndex: number,
  ) => {
    const optionKey = `${appId}:${prereqIndex}:${optionIndex}`;
    const prereqKey = `${appId}:${prereqIndex}`;
    setPrereqInstallRunning((prev) => ({ ...prev, [optionKey]: true }));
    setPrereqInstallMessage((prev) => ({ ...prev, [prereqKey]: "" }));
    setPrereqInstallError((prev) => ({ ...prev, [prereqKey]: "" }));
    try {
      const message = await falckService.runPrerequisiteInstall(
        repoPath,
        appId,
        prereqIndex,
        optionIndex,
      );
      setPrereqInstallMessage((prev) => ({ ...prev, [prereqKey]: message }));
    } catch (err) {
      setPrereqInstallError((prev) => ({
        ...prev,
        [prereqKey]: String(err),
      }));
    } finally {
      setPrereqInstallRunning((prev) => ({ ...prev, [optionKey]: false }));
      void checkPrereqs(appId);
    }
  };

  const handleLaunch = async (app: FalckApplication) => {
    setLaunchError((prev) => ({ ...prev, [app.id]: "" }));
    try {
      if (app.launch.dockerfile) {
        const mode = await backendService.getMode();
        setBackendMode(mode);
        if (mode === "virtualized") {
          const prereq = await backendService.checkPrereq();
          if (!prereq.installed) {
            const tool = prereq.tool || "Lima";
            const message =
              prereq.message ||
              `${tool} is required to run this Dockerfile. Install it now?`;
            const confirmed = window.confirm(`${message}\n\nInstall ${tool}?`);
            if (!confirmed) {
              setLaunchError((prev) => ({
                ...prev,
                [app.id]: `${tool} is required to run this Dockerfile.`,
              }));
              return;
            }
            await backendService.installPrereq();
          }
        }
      }
      const pid = await falckService.launchApp(repoPath, app.id);
      setRunningApps((prev) => ({ ...prev, [app.id]: pid }));
      if (app.launch.access?.open_browser && app.launch.access.url) {
      await falckService.openInBrowser(app.launch.access.url);
      }
    } catch (err) {
      setLaunchError((prev) => ({ ...prev, [app.id]: String(err) }));
    }
  };

  const handleStop = async (app: FalckApplication) => {
    const pid = runningApps[app.id];
    if (!pid) {
      return;
    }
    try {
      await falckService.killApp(pid);
      setRunningApps((prev) => {
        const next = { ...prev };
        delete next[app.id];
        return next;
      });
    } catch (err) {
      setLaunchError((prev) => ({ ...prev, [app.id]: String(err) }));
    }
  };

  const handleOpenUrl = async (url: string) => {
    try {
      await falckService.openInBrowser(url);
    } catch (err) {
      setError(`Failed to open browser: ${String(err)}`);
    }
  };

  const renderEmptyState = () => (
    <Card>
      <CardHeader>
        <CardTitle>Falck setup</CardTitle>
        <CardDescription>
          No Falck configuration found for this repository.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          Add a <code className="font-mono">.falck/config.yaml</code> file to
          show setup and launch steps for non-technical users.
        </p>
      </CardContent>
    </Card>
  );

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Falck setup</CardTitle>
          <CardDescription>Loading configuration...</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (!config) {
    return (
      <div className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {renderEmptyState()}
      </div>
    );
  }

  const appOptions = config.applications.map((app) => ({
    id: app.id,
    label: app.name,
  }));

  const dockerfileMode =
    Boolean(activeApp?.launch.dockerfile) && backendMode === "virtualized";
  const activeResults = activeApp ? prereqResults[activeApp.id] : [];
  const activePrereqs = activeApp?.prerequisites ?? [];
  const prereqsMissing = dockerfileMode
    ? false
    : activeResults?.some((result) => !result.installed && !result.optional);
  const secretsOk = activeApp
    ? activeApp.secrets && activeApp.secrets.length > 0
      ? Boolean(secretsSatisfied[activeApp.id])
      : true
    : true;
  const isRunning = activeApp ? Boolean(runningApps[activeApp.id]) : false;
  const setupStatus: SetupStatus = dockerfileMode
    ? "not_configured"
    : activeApp
      ? (setupStatusByApp[activeApp.id] ??
        (activeApp.setup?.check?.command ? "checking" : "not_configured"))
      : "unknown";
  const setupStatusMeta: Record<
    SetupStatus,
    { label: string; className: string }
  > = {
    complete: { label: "Setup complete", className: "bg-emerald-500" },
    incomplete: { label: "Setup incomplete", className: "bg-amber-500" },
    checking: {
      label: "Checking setup",
      className: "bg-amber-500 animate-pulse",
    },
    error: { label: "Setup check error", className: "bg-destructive" },
    not_configured: {
      label: "Setup check not configured",
      className: "bg-muted-foreground/40",
    },
    unknown: {
      label: "Setup status unknown",
      className: "bg-muted-foreground/40",
    },
  };
  const setupIndicator = setupStatusMeta[setupStatus];
  const setupCheckConfigured = dockerfileMode
    ? false
    : activeApp
      ? Boolean(activeApp.setup?.check?.command)
      : false;
  const setupBlocked = !dockerfileMode && setupCheckConfigured && setupStatus !== "complete";
  const setupNeedsAttention =
    !dockerfileMode && (setupStatus === "incomplete" || setupStatus === "error");

  return (
    <div className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {activeApp ? (
        <div className="space-y-4">
          <div className="border px-2 py-1 rounded bg-background">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex flex-wrap items-center gap-1">
                {appOptions.length > 1 ? (
                  <Select
                    value={activeApp.id}
                    onValueChange={(value) => setActiveAppId(value)}
                  >
                    <SelectTrigger className="h-8 w-[220px]">
                      <SelectValue placeholder="Select app" />
                    </SelectTrigger>
                    <SelectContent>
                      {appOptions.map((app) => (
                        <SelectItem key={app.id} value={app.id}>
                          {app.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <span className="text-sm font-semibold">
                    {activeApp.name}
                  </span>
                )}

                <Button
                  size="sm"
                  variant="ghost"
                  className="gap-1"
                  onClick={loadConfig}
                >
                  <RefreshCw className="h-3 w-3" />
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {isRunning && activeApp.launch.access?.url ? (
                  <Button
                    size="sm"
                    variant="link"
                    className="text-xs text-muted-foreground"
                    onClick={() => handleOpenUrl(activeApp.launch.access!.url!)}
                  >
                    {activeApp.launch.access?.url}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  className="gap-1"
                  onClick={() => setSetupDialogOpen(true)}
                >
                  <ListChecks className="h-4 w-4" />
                  Setup steps
                  <span
                    className={`ml-1 inline-flex h-2 w-2 rounded-full ${setupIndicator.className}`}
                    title={setupIndicator.label}
                  />
                  <span className="sr-only">{setupIndicator.label}</span>
                </Button>
                {isRunning ? (
                  <Button
                    size="sm"
                    className="gap-2"
                    onClick={() => handleStop(activeApp)}
                  >
                    <Square className="h-4 w-4" />
                    Stop
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    className="gap-2"
                    onClick={() => handleLaunch(activeApp)}
                    disabled={
                      Boolean(prereqsMissing) || !secretsOk || setupBlocked
                    }
                  >
                    <Play className="h-4 w-4" />
                    Start
                  </Button>
                )}
              </div>
            </div>
            <div className="space-y-2 pt-0">
              {!isRunning && prereqsMissing ? (
                <div className="rounded-lg border-2 border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  Missing prerequisites. Open setup steps to see what is needed.
                </div>
              ) : null}
              {!isRunning && setupNeedsAttention ? (
                <div className="rounded-lg border-2 border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  Setup is not complete. Open setup steps to finish.
                </div>
              ) : null}
              {!isRunning && !secretsOk && activeApp.secrets?.length ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border-2 border-yellow-200 bg-yellow-50 px-3 py-2 text-xs text-yellow-900">
                  <span>Secrets required to start this app.</span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setSecretsDialogApp(activeApp)}
                  >
                    Configure
                  </Button>
                </div>
              ) : null}
              {launchError[activeApp.id] && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    {launchError[activeApp.id]}
                  </AlertDescription>
                </Alert>
              )}
            </div>
          </div>

          <Dialog open={setupDialogOpen} onOpenChange={setSetupDialogOpen}>
            <DialogContent className="max-w-3xl">
              <DialogHeader>
                <DialogTitle>Setup steps</DialogTitle>
                <DialogDescription>
                  Everything needed before starting the app.
                </DialogDescription>
              </DialogHeader>
              <ScrollArea className="max-h-[70vh] pr-4">
                <div className="space-y-6 pr-2">
                  {activeApp.description && (
                    <p className="text-sm text-muted-foreground">
                      {activeApp.description}
                    </p>
                  )}

                  {activeApp.setup?.check?.command ? (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border-2 border-border bg-muted/40 px-3 py-2">
                      <div>
                        <p className="text-sm font-semibold">
                          Setup status: {setupIndicator.label}
                        </p>
                        {setupStatusMessage[activeApp.id] ? (
                          <p className="text-xs text-muted-foreground">
                            {setupStatusMessage[activeApp.id]}
                          </p>
                        ) : null}
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => checkSetupStatus(activeApp.id)}
                        disabled={setupStatus === "checking"}
                      >
                        {setupStatus === "checking"
                          ? "Checking..."
                          : "Re-check"}
                      </Button>
                    </div>
                  ) : null}

                  {activeApp.secrets && activeApp.secrets.length > 0 && (
                    <div
                      className={
                        secretsOk
                          ? "rounded-lg border-2 border-green-200 bg-green-50 px-3 py-2"
                          : "rounded-lg border-2 border-yellow-200 bg-yellow-50 px-3 py-2"
                      }
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <p className="text-sm font-semibold">
                            {secretsOk ? "Secrets ready" : "Secrets required"}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {secretsOk
                              ? "All required secrets are set."
                              : "Add the required secrets to continue."}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setSecretsDialogApp(activeApp)}
                        >
                          Configure
                        </Button>
                      </div>
                    </div>
                  )}

                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h3 className="text-sm font-semibold">Prerequisites</h3>
                        <p className="text-xs text-muted-foreground">
                          Check required tools before running this app.
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => checkPrereqs(activeApp.id)}
                        disabled={prereqLoading[activeApp.id]}
                      >
                        {prereqLoading[activeApp.id]
                          ? "Checking..."
                          : "Re-check"}
                      </Button>
                    </div>

                    {activePrereqs.length > 0 ? (
                      <div className="space-y-3">
                        {activePrereqs.map((prereq, prereqIndex) => {
                          const result = activeResults?.[prereqIndex];
                          const prereqKey = `${activeApp.id}:${prereqIndex}`;
                          return (
                            <PrerequisiteStatus
                              key={`${prereq.name}-${prereqIndex}`}
                              prereq={prereq}
                              result={result}
                              onOpenInstallUrl={handleOpenUrl}
                              onRunInstallOption={(optionIndex) =>
                                handlePrereqInstall(
                                  activeApp.id,
                                  prereqIndex,
                                  optionIndex,
                                )
                              }
                              isOptionRunning={(optionIndex) =>
                                Boolean(
                                  prereqInstallRunning[
                                    `${activeApp.id}:${prereqIndex}:${optionIndex}`
                                  ],
                                )
                              }
                              installMessage={prereqInstallMessage[prereqKey]}
                              installError={prereqInstallError[prereqKey]}
                            />
                          );
                        })}
                      </div>
                    ) : (
                      <div className="rounded-lg border-2 border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
                        No prerequisites configured.
                      </div>
                    )}
                  </div>

                  {activeApp.setup?.steps &&
                    activeApp.setup.steps.length > 0 && (
                      <div className="space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <h3 className="text-sm font-semibold">Install</h3>
                            <p className="text-xs text-muted-foreground">
                              Run the setup steps for this app.
                            </p>
                          </div>
                          <Button
                            size="sm"
                            onClick={() => handleSetup(activeApp)}
                            disabled={setupRunning[activeApp.id]}
                          >
                            {setupRunning[activeApp.id]
                              ? "Installing..."
                              : "Run setup"}
                          </Button>
                        </div>

                        <div className="space-y-2">
                          {activeApp.setup.steps.map((step) => (
                            <div
                              key={step.name}
                              className="rounded-lg border-2 border-border bg-card/80 px-4 py-3"
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <span className="text-sm font-medium">
                                  {step.name}
                                </span>
                                {step.optional && (
                                  <Badge variant="outline">Optional</Badge>
                                )}
                              </div>
                              {step.description && (
                                <p className="text-xs text-muted-foreground mt-1">
                                  {step.description}
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                        {setupMessage[activeApp.id] && (
                          <Alert>
                            <CheckCircle2 className="h-4 w-4" />
                            <AlertDescription>
                              {setupMessage[activeApp.id]}
                            </AlertDescription>
                          </Alert>
                        )}
                        {setupError[activeApp.id] && (
                          <Alert variant="destructive">
                            <AlertCircle className="h-4 w-4" />
                            <AlertDescription>
                              {setupError[activeApp.id]}
                            </AlertDescription>
                          </Alert>
                        )}
                      </div>
                    )}

                  {activeApp.launch.access?.url && (
                    <div className="rounded-lg border-2 border-border bg-muted/40 px-3 py-2 text-xs">
                      <p className="font-medium">Access</p>
                      <p className="text-muted-foreground">
                        {activeApp.launch.access.url}
                      </p>
                    </div>
                  )}
                </div>
              </ScrollArea>
            </DialogContent>
          </Dialog>
        </div>
      ) : null}

      {secretsDialogApp && (
        <SecretsDialog
          open={Boolean(secretsDialogApp)}
          onOpenChange={(open) => {
            if (!open) {
              setSecretsDialogApp(null);
            }
          }}
          repoPath={repoPath}
          appId={secretsDialogApp.id}
          appName={secretsDialogApp.name}
          onSecretsSaved={() => {
            void checkSecrets(secretsDialogApp.id);
          }}
        />
      )}
    </div>
  );
}
