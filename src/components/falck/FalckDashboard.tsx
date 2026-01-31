import { useEffect, useMemo, useState } from "react";
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
  Lock,
  Play,
  RefreshCw,
  Square,
  Terminal,
} from "lucide-react";
import {
  falckService,
  FalckApplication,
  FalckConfig,
  PrerequisiteCheckResult,
} from "@/services/falckService";
import { PrerequisiteStatus } from "@/components/falck/PrerequisiteStatus";
import { SecretsDialog } from "@/components/falck/SecretsDialog";

interface FalckDashboardProps {
  repoPath: string;
}

export function FalckDashboard({ repoPath }: FalckDashboardProps) {
  const [config, setConfig] = useState<FalckConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeAppId, setActiveAppId] = useState<string | null>(null);
  const [prereqResults, setPrereqResults] = useState<
    Record<string, PrerequisiteCheckResult[]>
  >({});
  const [prereqLoading, setPrereqLoading] = useState<Record<string, boolean>>({});
  const [setupRunning, setSetupRunning] = useState<Record<string, boolean>>({});
  const [setupMessage, setSetupMessage] = useState<Record<string, string>>({});
  const [setupError, setSetupError] = useState<Record<string, string>>({});
  const [launchError, setLaunchError] = useState<Record<string, string>>({});
  const [runningApps, setRunningApps] = useState<Record<string, number>>({});
  const [secretsSatisfied, setSecretsSatisfied] = useState<Record<string, boolean>>(
    {},
  );
  const [secretsDialogApp, setSecretsDialogApp] = useState<FalckApplication | null>(
    null,
  );

  useEffect(() => {
    void loadConfig();
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
    config.applications.forEach((app) => {
      void checkPrereqs(app.id);
      if (app.secrets && app.secrets.length > 0) {
        void checkSecrets(app.id);
      } else {
        setSecretsSatisfied((prev) => ({ ...prev, [app.id]: true }));
      }
    });
  }, [config]);

  const activeApp = useMemo(
    () =>
      config?.applications.find((app) => app.id === activeAppId) ??
      config?.applications[0] ??
      null,
    [config, activeAppId],
  );

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

  const checkSecrets = async (appId: string) => {
    try {
      const satisfied = await falckService.checkSecretsSatisfied(repoPath, appId);
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
    }
  };

  const handleLaunch = async (app: FalckApplication) => {
    setLaunchError((prev) => ({ ...prev, [app.id]: "" }));
    try {
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

  const activeResults = activeApp ? prereqResults[activeApp.id] : [];
  const prereqsMissing = activeResults?.some(
    (result) => !result.installed && !result.optional,
  );
  const secretsOk = activeApp
    ? activeApp.secrets && activeApp.secrets.length > 0
      ? Boolean(secretsSatisfied[activeApp.id])
      : true
    : true;
  const isRunning = activeApp ? Boolean(runningApps[activeApp.id]) : false;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-2">
            <CardTitle className="flex items-center gap-2">
              <Terminal className="h-5 w-5" />
              {config.metadata?.name || "Falck setup"}
            </CardTitle>
            <CardDescription>
              {config.metadata?.description ||
                "Run this repo with guided setup steps."}
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {config.install_order && config.install_order.length > 0 && (
              <Badge variant="secondary">
                Install order: {config.install_order.join(" -> ")}
              </Badge>
            )}
            {config.launch_order && config.launch_order.length > 0 && (
              <Badge variant="outline">
                Launch order: {config.launch_order.join(" -> ")}
              </Badge>
            )}
            <Button variant="outline" size="sm" onClick={loadConfig}>
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
          </div>
        </CardHeader>
      </Card>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className="space-y-3">
          <CardTitle>Choose an app</CardTitle>
          <CardDescription>
            Each application can have its own setup, secrets, and launch steps.
          </CardDescription>
          <Select
            value={activeApp?.id}
            onValueChange={(value) => setActiveAppId(value)}
          >
            <SelectTrigger className="max-w-sm">
              <SelectValue placeholder="Select an app" />
            </SelectTrigger>
            <SelectContent>
              {appOptions.map((app) => (
                <SelectItem key={app.id} value={app.id}>
                  {app.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardHeader>
      </Card>

      {activeApp ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-6">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle>{activeApp.name}</CardTitle>
                  <CardDescription>{activeApp.description}</CardDescription>
                </div>
                <Badge variant={isRunning ? "default" : "outline"}>
                  {isRunning ? "Running" : "Idle"}
                </Badge>
              </CardHeader>
              <CardContent className="space-y-6">
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

                  {activeResults && activeResults.length > 0 ? (
                    <div className="space-y-3">
                      {activeResults.map((result) => (
                        <PrerequisiteStatus
                          key={result.name}
                          result={result}
                          onOpenInstallUrl={handleOpenUrl}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-lg border-2 border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
                      No prerequisites configured.
                    </div>
                  )}

                  {prereqsMissing && (
                    <Alert variant="destructive">
                      <AlertCircle className="h-4 w-4" />
                      <AlertDescription>
                        Install the missing prerequisites before continuing.
                      </AlertDescription>
                    </Alert>
                  )}
                </div>

                {activeApp.setup?.steps && activeApp.setup.steps.length > 0 && (
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

                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-semibold">Launch</h3>
                      <p className="text-xs text-muted-foreground">
                        Start or stop the app when you're ready.
                      </p>
                    </div>
                    {isRunning ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleStop(activeApp)}
                      >
                        <Square className="h-4 w-4" />
                        Stop
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        onClick={() => handleLaunch(activeApp)}
                        disabled={Boolean(prereqsMissing) || !secretsOk}
                      >
                        <Play className="h-4 w-4" />
                        Launch
                      </Button>
                    )}
                  </div>
                  {activeApp.launch.description && (
                    <p className="text-xs text-muted-foreground">
                      {activeApp.launch.description}
                    </p>
                  )}
                  {!secretsOk && activeApp.secrets?.length ? (
                    <Alert className="border-yellow-200 bg-yellow-50 text-yellow-900">
                      <AlertCircle className="h-4 w-4 text-yellow-700" />
                      <AlertDescription>
                        Configure required secrets before launching.
                      </AlertDescription>
                    </Alert>
                  ) : null}
                  {activeApp.launch.access?.url && (
                    <div className="rounded-lg border-2 border-border bg-muted/40 p-3 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">Access</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            handleOpenUrl(activeApp.launch.access!.url!)
                          }
                        >
                          Open
                        </Button>
                      </div>
                      <p className="mt-1 text-muted-foreground">
                        {activeApp.launch.access.url}
                      </p>
                    </div>
                  )}
                  {launchError[activeApp.id] && (
                    <Alert variant="destructive">
                      <AlertCircle className="h-4 w-4" />
                      <AlertDescription>
                        {launchError[activeApp.id]}
                      </AlertDescription>
                    </Alert>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-6">
            {activeApp.secrets && activeApp.secrets.length > 0 && (
              <Card
                className={
                  secretsOk
                    ? "border-green-200 bg-green-50"
                    : "border-yellow-200 bg-yellow-50"
                }
              >
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Lock className="h-5 w-5" />
                      <CardTitle className="text-base">
                        {secretsOk
                          ? "Secrets configured"
                          : "Secrets required"}
                      </CardTitle>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setSecretsDialogApp(activeApp)}
                    >
                      Configure
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="text-xs text-muted-foreground">
                    {secretsOk
                      ? "All required secrets are set for this app."
                      : "Provide the required secrets before launching."}
                  </p>
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle className="text-base">App details</CardTitle>
                <CardDescription>
                  Root: <span className="font-mono">{activeApp.root}</span>
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-xs text-muted-foreground">
                <p>
                  ID: <span className="font-mono">{activeApp.id}</span>
                </p>
                <p>
                  Type: <span className="font-mono">{activeApp.type}</span>
                </p>
                <p>
                  Launch command:{" "}
                  <span className="font-mono">{activeApp.launch.command}</span>
                </p>
                {activeApp.launch.ports && activeApp.launch.ports.length > 0 && (
                  <p>
                    Ports:{" "}
                    <span className="font-mono">
                      {activeApp.launch.ports.join(", ")}
                    </span>
                  </p>
                )}
              </CardContent>
            </Card>

            {activeApp.launch.access?.url && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Access</CardTitle>
                  <CardDescription>
                    How to reach the app once it is running.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2 text-xs text-muted-foreground">
                  <p>
                    URL:{" "}
                    <span className="font-mono">
                      {activeApp.launch.access.url}
                    </span>
                  </p>
                  {activeApp.launch.access.port && (
                    <p>
                      Port:{" "}
                      <span className="font-mono">
                        {activeApp.launch.access.port}
                      </span>
                    </p>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
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
