import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
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
  Circle,
  CheckCircle2,
  Loader2,
  ListChecks,
  Play,
  RefreshCw,
  Square,
  type LucideIcon,
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
  SetupStepCheckResult,
  LaunchResult,
} from "@/services/falckService";
import { containerService } from "@/services/containerService";
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

type SetupStepProgress = "pending" | "running" | "complete" | "failed" | "skipped";

type RunningAppHandle =
  | { kind: "process"; pid: number }
  | {
      kind: "container";
      id: string;
      name: string;
      vm: string;
      repoPath: string;
    };

interface ContainerStatusEvent {
  status: string;
  message: string;
  repo_path?: string;
  app_id?: string;
  vm?: string;
  container?: string;
}

interface ContainerLogEvent {
  log: string;
  repo_path?: string;
  app_id?: string;
  vm?: string;
  container?: string;
}

interface SetupStepEvent {
  repo_path?: string;
  app_id?: string;
  step_index: number;
  step_name?: string;
  status: "started" | "completed" | "failed" | "skipped";
  message?: string;
}

export function FalckDashboard({
  repoPath,
  onActiveAppChange,
}: FalckDashboardProps) {
  const [config, setConfig] = useState<FalckConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeAppId, setActiveAppId] = useState<string | null>(null);
  const [setupStepChecksByApp, setSetupStepChecksByApp] = useState<
    Record<string, SetupStepCheckResult[]>
  >({});
  const [setupCheckLoading, setSetupCheckLoading] = useState<
    Record<string, boolean>
  >({});
  const [setupRunning, setSetupRunning] = useState<Record<string, boolean>>({});
  const [setupMessage, setSetupMessage] = useState<Record<string, string>>({});
  const [setupError, setSetupError] = useState<Record<string, string>>({});
  const [setupStepStatusByApp, setSetupStepStatusByApp] = useState<
    Record<string, SetupStepProgress[]>
  >({});
  const [launchError, setLaunchError] = useState<Record<string, string>>({});
  const [runningApps, setRunningApps] = useState<
    Record<string, RunningAppHandle>
  >({});
  const [launchingApps, setLaunchingApps] = useState<Record<string, boolean>>(
    {},
  );
  const [containerStatusByApp, setContainerStatusByApp] = useState<
    Record<string, { status: string; message: string }>
  >({});
  const [containerLogsByApp, setContainerLogsByApp] = useState<
    Record<string, string[]>
  >({});
  const runningAppsRef = useRef<Record<string, RunningAppHandle>>({});
  const [setupDialogOpen, setSetupDialogOpen] = useState(false);
  const [containerLogsOpen, setContainerLogsOpen] = useState(false);
  const [secretsSatisfied, setSecretsSatisfied] = useState<
    Record<string, boolean>
  >({});
  const [secretsDialogApp, setSecretsDialogApp] =
    useState<FalckApplication | null>(null);
  const [setupStepTeardownRunning, setSetupStepTeardownRunning] = useState<
    Record<string, boolean>
  >({});
  const [autoSetupRunning, setAutoSetupRunning] = useState<
    Record<string, boolean>
  >({});
  const [autoSetupMessage, setAutoSetupMessage] = useState<
    Record<string, string>
  >({});
  const [autoSetupError, setAutoSetupError] = useState<
    Record<string, string>
  >({});
  const [autoSetupOverlayByApp, setAutoSetupOverlayByApp] = useState<
    Record<string, boolean>
  >({});
  const normalizeRepoPath = (path?: string | null) =>
    (path ?? "").replace(/[\\/]+$/, "");

  useEffect(() => {
    void loadConfig();
  }, [repoPath]);

  useEffect(() => {
    runningAppsRef.current = runningApps;
  }, [runningApps]);

  useEffect(() => {
    setRunningApps({});
    setLaunchError({});
    setLaunchingApps({});
    setContainerStatusByApp({});
    setContainerLogsByApp({});
    setContainerLogsOpen(false);
    setSetupStepStatusByApp({});
    setSetupStepChecksByApp({});
    setSetupCheckLoading({});
    setSetupStepTeardownRunning({});
    setAutoSetupRunning({});
    setAutoSetupMessage({});
    setAutoSetupError({});
    setAutoSetupOverlayByApp({});
  }, [repoPath]);

  useEffect(() => {
    setContainerLogsOpen(false);
  }, [activeAppId]);

  useEffect(() => {
    return () => {
      const running = Object.values(runningAppsRef.current);
      if (running.length === 0) {
        return;
      }
      running.forEach((handle) => {
        if (handle.kind === "process") {
          void falckService.killApp(handle.pid);
        } else {
          void containerService.stopContainer(
            handle.id,
            handle.vm,
            handle.name,
          );
        }
      });
    };
  }, [repoPath]);

  useEffect(() => {
    let unlistenStatus: (() => void) | undefined;
    let unlistenLogs: (() => void) | undefined;
    let unlistenSetupSteps: (() => void) | undefined;

    const setupListeners = async () => {
      unlistenStatus = await listen<ContainerStatusEvent>(
        "container-status",
        (event) => {
          const payload = event.payload;
          if (!payload.repo_path || payload.repo_path !== repoPath) {
            return;
          }
          if (!payload.app_id) {
            return;
          }
          setContainerStatusByApp((prev) => ({
            ...prev,
            [payload.app_id!]: {
              status: payload.status,
              message: payload.message,
            },
          }));
        },
      );

      unlistenLogs = await listen<ContainerLogEvent>(
        "container-log",
        (event) => {
          const payload = event.payload;
          if (!payload.repo_path || payload.repo_path !== repoPath) {
            return;
          }
          if (!payload.app_id) {
            return;
          }
          setContainerLogsByApp((prev) => {
            const existing = prev[payload.app_id!] ?? [];
            const next = [...existing, payload.log].slice(-200);
            return { ...prev, [payload.app_id!]: next };
          });
        },
      );

      unlistenSetupSteps = await listen<SetupStepEvent>(
        "falck:setup-step",
        (event) => {
          const payload = event.payload;
          if (!payload) {
            return;
          }
          if (
            payload.repo_path &&
            normalizeRepoPath(payload.repo_path) !== normalizeRepoPath(repoPath)
          ) {
            return;
          }
          if (!payload.app_id) {
            return;
          }
          const appId = payload.app_id;
          setSetupStepStatusByApp((prev) => {
            const existing = prev[appId] ?? [];
            const next = [...existing];
            const status: SetupStepProgress =
              payload.status === "started"
                ? "running"
                : payload.status === "completed"
                  ? "complete"
                  : payload.status === "failed"
                    ? "failed"
                    : "skipped";
            if (payload.step_index >= next.length) {
              next.length = payload.step_index + 1;
              for (let i = 0; i < next.length; i += 1) {
                if (!next[i]) {
                  next[i] = "pending";
                }
              }
            }
            next[payload.step_index] = status;
            return { ...prev, [appId]: next };
          });
        },
      );
    };

    void setupListeners();

    return () => {
      if (unlistenStatus) {
        unlistenStatus();
      }
      if (unlistenLogs) {
        unlistenLogs();
      }
      if (unlistenSetupSteps) {
        unlistenSetupSteps();
      }
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
    config.applications.forEach((app) => {
      void checkSetupSteps(app.id);
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

  useEffect(() => {
    onActiveAppChange?.(activeApp);
  }, [activeApp, onActiveAppChange]);

  const checkSetupSteps = async (
    appId: string,
    options?: { throwOnError?: boolean },
  ): Promise<SetupStepCheckResult[]> => {
    setSetupCheckLoading((prev) => ({ ...prev, [appId]: true }));
    try {
      const results = await falckService.checkSetupSteps(repoPath, appId);
      setSetupStepChecksByApp((prev) => ({ ...prev, [appId]: results }));
      return results;
    } catch (err) {
      setSetupStepChecksByApp((prev) => ({ ...prev, [appId]: [] }));
      setError(`Failed to check setup steps: ${String(err)}`);
      if (options?.throwOnError) {
        throw err;
      }
      return [];
    } finally {
      setSetupCheckLoading((prev) => ({ ...prev, [appId]: false }));
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

  const runSetupWithState = async (
    app: FalckApplication,
  ): Promise<boolean> => {
    setSetupRunning((prev) => ({ ...prev, [app.id]: true }));
    setSetupError((prev) => ({ ...prev, [app.id]: "" }));
    setSetupMessage((prev) => ({ ...prev, [app.id]: "" }));
    if (app.setup?.steps?.length) {
      setSetupStepStatusByApp((prev) => ({
        ...prev,
        [app.id]: app.setup!.steps!.map((_, index) =>
          index === 0 ? "running" : "pending",
        ),
      }));
    }
    try {
      const message = await falckService.runSetup(repoPath, app.id);
      setSetupMessage((prev) => ({ ...prev, [app.id]: message }));
      if (app.setup?.steps?.length) {
        setSetupStepStatusByApp((prev) => ({
          ...prev,
          [app.id]: app.setup!.steps!.map(() => "complete"),
        }));
      }
      return true;
    } catch (err) {
      setSetupError((prev) => ({ ...prev, [app.id]: String(err) }));
      setSetupStepStatusByApp((prev) => {
        const existing = prev[app.id] ?? [];
        if (existing.length === 0) {
          return prev;
        }
        const next = [...existing];
        let failedIndex = next.findIndex((status) => status === "running");
        if (failedIndex === -1) {
          failedIndex = next.findIndex((status) => status === "pending");
        }
        if (failedIndex !== -1) {
          next[failedIndex] = "failed";
        }
        return { ...prev, [app.id]: next };
      });
      return false;
    } finally {
      setSetupRunning((prev) => ({ ...prev, [app.id]: false }));
      void checkSetupSteps(app.id);
    }
  };

  const handleSetup = async (app: FalckApplication) => {
    await runSetupWithState(app);
  };

  const runSetupStepWithState = async (
    app: FalckApplication,
    stepIndex: number,
  ): Promise<boolean> => {
    setSetupError((prev) => ({ ...prev, [app.id]: "" }));
    setSetupMessage((prev) => ({ ...prev, [app.id]: "" }));
    setSetupStepStatusByApp((prev) => {
      const existing = prev[app.id] ?? [];
      const next = [...existing];
      if (next.length <= stepIndex) {
        next.length = stepIndex + 1;
        for (let i = 0; i < next.length; i += 1) {
          if (!next[i]) {
            next[i] = "pending";
          }
        }
      }
      next[stepIndex] = "running";
      return { ...prev, [app.id]: next };
    });
    try {
      const message = await falckService.runSetupStep(
        repoPath,
        app.id,
        stepIndex,
      );
      setSetupMessage((prev) => ({ ...prev, [app.id]: message }));
      return true;
    } catch (err) {
      setSetupError((prev) => ({ ...prev, [app.id]: String(err) }));
      setSetupStepStatusByApp((prev) => {
        const existing = prev[app.id] ?? [];
        const next = [...existing];
        if (next.length <= stepIndex) {
          next.length = stepIndex + 1;
        }
        next[stepIndex] = "failed";
        return { ...prev, [app.id]: next };
      });
      return false;
    } finally {
      void checkSetupSteps(app.id);
    }
  };

  const runSetupStepTeardown = async (
    app: FalckApplication,
    stepIndex: number,
  ) => {
    const key = `${app.id}:${stepIndex}`;
    setSetupError((prev) => ({ ...prev, [app.id]: "" }));
    setSetupMessage((prev) => ({ ...prev, [app.id]: "" }));
    setSetupStepTeardownRunning((prev) => ({ ...prev, [key]: true }));
    try {
      const message = await falckService.runSetupStepTeardown(
        repoPath,
        app.id,
        stepIndex,
      );
      setSetupMessage((prev) => ({ ...prev, [app.id]: message }));
    } catch (err) {
      setSetupError((prev) => ({ ...prev, [app.id]: String(err) }));
    } finally {
      setSetupStepTeardownRunning((prev) => ({ ...prev, [key]: false }));
      void checkSetupSteps(app.id);
    }
  };

  const resolveLaunchHandle = (result: LaunchResult): RunningAppHandle => {
    if (result.kind === "process") {
      return { kind: "process", pid: result.pid };
    }
    return {
      kind: "container",
      id: result.container.id,
      name: result.container.name,
      vm: result.container.vm,
      repoPath: result.container.repo_path,
    };
  };

  const performLaunch = async (
    app: FalckApplication,
    options?: { skipLimaCheck?: boolean },
  ) => {
    setLaunchError((prev) => ({ ...prev, [app.id]: "" }));
    setLaunchingApps((prev) => ({ ...prev, [app.id]: true }));
    if (app.launch.container) {
      setContainerLogsByApp((prev) => ({ ...prev, [app.id]: [] }));
      setContainerStatusByApp((prev) => ({
        ...prev,
        [app.id]: { status: "starting", message: "Starting container..." },
      }));
    }
    try {
      if (app.launch.container && !options?.skipLimaCheck) {
        const limaStatus = await containerService.checkLimaInstalled();
        if (!limaStatus.installed) {
          const message =
            "Lima is unavailable in this build. Reinstall Falck or use a build that bundles Lima.";
          setLaunchError((prev) => ({ ...prev, [app.id]: message }));
          setContainerStatusByApp((prev) => ({
            ...prev,
            [app.id]: { status: "error", message },
          }));
          setLaunchingApps((prev) => ({ ...prev, [app.id]: false }));
          return;
        }
      }

      const result = await falckService.launchApp(repoPath, app.id);
      const handle = resolveLaunchHandle(result);
      setRunningApps((prev) => ({ ...prev, [app.id]: handle }));
      if (app.launch.access?.open_browser && app.launch.access.url) {
        await falckService.openInBrowser(app.launch.access.url);
      }
    } catch (err) {
      setLaunchError((prev) => ({ ...prev, [app.id]: String(err) }));
    } finally {
      setLaunchingApps((prev) => ({ ...prev, [app.id]: false }));
    }
  };

  const handleLaunch = async (app: FalckApplication) => {
    if (autoSetupRunning[app.id] || launchingApps[app.id]) {
      return;
    }

    if (app.secrets && app.secrets.length > 0 && !secretsSatisfied[app.id]) {
      setSecretsDialogApp(app);
      return;
    }

    setLaunchError((prev) => ({ ...prev, [app.id]: "" }));
    setAutoSetupError((prev) => ({ ...prev, [app.id]: "" }));
    setAutoSetupMessage((prev) => ({
      ...prev,
      [app.id]: "Checking setup steps...",
    }));
    setAutoSetupRunning((prev) => ({ ...prev, [app.id]: true }));

    const updateAutoSetupMessage = (message: string) =>
      setAutoSetupMessage((prev) => ({ ...prev, [app.id]: message }));

    try {
      const steps = app.setup?.steps ?? [];
      const stepChecks = await checkSetupSteps(app.id, { throwOnError: true });
      const hasSteps = steps.length > 0;

      if (!hasSteps) {
        updateAutoSetupMessage("Starting the app...");
        await performLaunch(app);
        return;
      }

      const missingChecks = stepChecks.filter(
        (result) => result.status === "missing_check",
      );
      if (missingChecks.length > 0) {
        const names = missingChecks.map((result) => result.name).join(", ");
        throw new Error(
          `Setup checks are missing for: ${names}. Add step checks to continue.`,
        );
      }

      const stepsToRun = steps
        .map((step, index) => ({
          step,
          index,
          result: stepChecks[index],
        }))
        .filter(
          ({ result }) => {
            if (!result) {
              return true;
            }
            if (result.status === "complete" || result.status === "skipped") {
              return false;
            }
            if (result.status === "missing_check") {
              return false;
            }
            return true;
          },
        );

      if (stepsToRun.length === 0) {
        updateAutoSetupMessage("Starting the app...");
        await performLaunch(app);
        return;
      }

      setSetupStepStatusByApp((prev) => {
        const existing = prev[app.id] ?? [];
        const next = [...existing];
        const indices = stepsToRun.map((entry) => entry.index);
        const maxIndex = Math.max(-1, ...indices);
        if (next.length <= maxIndex) {
          next.length = maxIndex + 1;
          for (let i = 0; i < next.length; i += 1) {
            if (!next[i]) {
              next[i] = "pending";
            }
          }
        }
        indices.forEach((index) => {
          next[index] = "pending";
        });
        return { ...prev, [app.id]: next };
      });
      setAutoSetupOverlayByApp((prev) => ({ ...prev, [app.id]: true }));
      updateAutoSetupMessage("Running setup steps...");

      for (const entry of stepsToRun) {
        updateAutoSetupMessage(`Running ${entry.step.name}...`);
        const ok = await runSetupStepWithState(app, entry.index);
        const optional = Boolean(entry.step.optional);
        if (!ok && !optional) {
          throw new Error(
            `Setup step '${entry.step.name}' failed. Open setup steps to review.`,
          );
        }
        const refreshed = await checkSetupSteps(app.id, { throwOnError: true });
        const refreshedResult = refreshed[entry.index];
        if (!optional) {
          if (
            !refreshedResult ||
            (refreshedResult.status !== "complete" &&
              refreshedResult.status !== "skipped")
          ) {
            throw new Error(
              `Setup step '${entry.step.name}' did not pass its check.`,
            );
          }
        }
      }

      updateAutoSetupMessage("Starting the app...");
      await performLaunch(app);
    } catch (err) {
      setAutoSetupError((prev) => ({
        ...prev,
        [app.id]: String(err),
      }));
    } finally {
      setAutoSetupRunning((prev) => ({ ...prev, [app.id]: false }));
      setAutoSetupOverlayByApp((prev) => ({ ...prev, [app.id]: false }));
    }
  };

  const handleStop = async (app: FalckApplication) => {
    const handle = runningApps[app.id];
    if (!handle) {
      return;
    }
    try {
      if (handle.kind === "process") {
        await falckService.killApp(handle.pid);
      } else {
        await containerService.stopContainer(handle.id, handle.vm, handle.name);
        setContainerStatusByApp((prev) => ({
          ...prev,
          [app.id]: { status: "stopped", message: "Container stopped" },
        }));
      }
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

  const activeSetupSteps = activeApp?.setup?.steps ?? [];
  const activeStepChecks = activeApp
    ? setupStepChecksByApp[activeApp.id] ?? []
    : [];
  const activeSetupCheckLoading = activeApp
    ? Boolean(setupCheckLoading[activeApp.id])
    : false;
  const setupStepsConfigured = activeSetupSteps.length > 0;
  const requiredStepCount = activeSetupSteps.filter(
    (step) => !step.optional,
  ).length;
  const requiredStepChecks = activeStepChecks.filter(
    (result) => !result.optional,
  );
  const allStatuses = activeStepChecks.map((result) => result.status);
  const missingCheckCount = allStatuses.filter(
    (status) => status === "missing_check",
  ).length;
  const errorCheckCount = requiredStepChecks.filter(
    (result) => result.status === "error",
  ).length;
  const incompleteCount = requiredStepChecks.filter(
    (result) => result.status === "incomplete",
  ).length;
  const completeCount = requiredStepChecks.filter(
    (result) => result.status === "complete" || result.status === "skipped",
  ).length;
  const setupChecksReady =
    setupStepsConfigured && activeStepChecks.length === activeSetupSteps.length;
  const secretsOk = activeApp
    ? activeApp.secrets && activeApp.secrets.length > 0
      ? Boolean(secretsSatisfied[activeApp.id])
      : true
    : true;
  const isRunning = activeApp ? Boolean(runningApps[activeApp.id]) : false;
  const isLaunching = activeApp ? Boolean(launchingApps[activeApp.id]) : false;
  const autoSetupActive = activeApp
    ? Boolean(autoSetupRunning[activeApp.id])
    : false;
  const autoSetupOverlayActive = activeApp
    ? Boolean(autoSetupOverlayByApp[activeApp.id])
    : false;
  const autoSetupNote = activeApp ? autoSetupMessage[activeApp.id] : "";
  const autoSetupFailure = activeApp ? autoSetupError[activeApp.id] : "";
  const isSetupInstalling = activeApp ? Boolean(setupRunning[activeApp.id]) : false;
  const isStepRunning = activeApp
    ? (setupStepStatusByApp[activeApp.id] ?? []).some(
        (status) => status === "running",
      )
    : false;
  const isTeardownRunning = activeApp
    ? Object.entries(setupStepTeardownRunning).some(
        ([key, running]) => running && key.startsWith(`${activeApp.id}:`),
      )
    : false;
  const activeContainerStatus = activeApp
    ? containerStatusByApp[activeApp.id]
    : undefined;
  const activeContainerLogs = activeApp
    ? (containerLogsByApp[activeApp.id] ?? [])
    : [];
  const formatContainerMessage = (status?: string, message?: string) => {
    const trimmed = (message ?? "").trim();
    if (trimmed) {
      return trimmed
        .replace(/Lima VM/gi, "virtual machine")
        .replace(/Building image/gi, "Building container image")
        .replace(/Container '([^']+)' running/gi, "Container '$1' is running")
        .replace(/Container running/gi, "Container is running");
    }

    switch ((status ?? "").toLowerCase()) {
      case "creating":
        return "Creating the virtual machine that hosts your container.";
      case "starting":
        return "Starting the container and preparing services.";
      case "stopping":
        return "Stopping the container safely.";
      case "restarting":
        return "Restarting the virtual machine to enable file writes.";
      case "building":
        return "Building the container image from your Dockerfile.";
      case "running":
        return "Container is running and ready for use.";
      case "stopped":
        return "The container is currently stopped.";
      case "removed":
        return "The container has been removed.";
      case "error":
      case "failed":
        return "Something went wrong while starting the container.";
      default:
        return "No container activity yet.";
    }
  };
  const containerActivityStatus = (
    activeContainerStatus?.status ?? (isLaunching ? "starting" : "idle")
  ).toLowerCase();
  const containerActivityMessage = formatContainerMessage(
    containerActivityStatus,
    activeContainerStatus?.message,
  );
  const containerActivityMeta: Record<
    string,
    { title: string; dotClass: string }
  > = {
    idle: {
      title: "Container idle",
      dotClass: "bg-muted-foreground/40",
    },
    creating: {
      title: "Preparing container",
      dotClass: "bg-sky-500 animate-pulse",
    },
    starting: {
      title: "Starting container",
      dotClass: "bg-sky-500 animate-pulse",
    },
    stopping: {
      title: "Stopping container",
      dotClass: "bg-amber-500 animate-pulse",
    },
    restarting: {
      title: "Restarting container host",
      dotClass: "bg-sky-500 animate-pulse",
    },
    building: {
      title: "Building container",
      dotClass: "bg-sky-500 animate-pulse",
    },
    running: {
      title: "Container running",
      dotClass: "bg-emerald-500",
    },
    stopped: {
      title: "Container stopped",
      dotClass: "bg-amber-500",
    },
    removed: {
      title: "Container removed",
      dotClass: "bg-amber-500",
    },
    error: {
      title: "Container error",
      dotClass: "bg-destructive",
    },
    failed: {
      title: "Container error",
      dotClass: "bg-destructive",
    },
  };
  const containerActivity =
    containerActivityMeta[containerActivityStatus] ??
    containerActivityMeta.idle;
  const setupStatus: SetupStatus = (() => {
    if (!setupStepsConfigured) {
      return "not_configured";
    }
    if (activeSetupCheckLoading || !setupChecksReady) {
      return "checking";
    }
    if (errorCheckCount > 0) {
      return "error";
    }
    if (missingCheckCount > 0 || incompleteCount > 0) {
      return "incomplete";
    }
    if (completeCount >= requiredStepCount) {
      return "complete";
    }
    return "unknown";
  })();
  const setupStatusMessage = (() => {
    if (!setupStepsConfigured) {
      return "";
    }
    if (activeSetupCheckLoading || !setupChecksReady) {
      return "Checking setup steps...";
    }
    if (missingCheckCount > 0) {
      return `${missingCheckCount} step${
        missingCheckCount === 1 ? "" : "s"
      } missing checks.`;
    }
    if (errorCheckCount > 0) {
      return "Some setup checks failed.";
    }
    if (requiredStepCount === 0) {
      return "No required setup steps.";
    }
    if (completeCount >= requiredStepCount) {
      return "All required setup steps complete.";
    }
    return `${completeCount} of ${requiredStepCount} required steps complete.`;
  })();
  const setupStatusMeta: Record<
    SetupStatus,
    { label: string; className: string }
  > = {
    complete: { label: "Setup complete", className: "bg-emerald-500" },
    incomplete: { label: "Setup incomplete", className: "bg-amber-500" },
    checking: {
      label: "Checking setup steps",
      className: "bg-sky-500 animate-pulse",
    },
    error: { label: "Setup checks failed", className: "bg-destructive" },
    not_configured: {
      label: "No setup steps",
      className: "bg-muted-foreground/40",
    },
    unknown: {
      label: "Setup status unknown",
      className: "bg-muted-foreground/40",
    },
  };
  const setupIndicator = setupStatusMeta[setupStatus];
  const autoSetupChecklist = activeSetupSteps.map((step, index) => {
    const actionStatus = activeApp
      ? setupStepStatusByApp[activeApp.id]?.[index]
      : undefined;
    const checkResult = activeStepChecks[index];
    const checkStatus = checkResult?.status;
    const isRunning = actionStatus === "running";
    const isFailed = actionStatus === "failed";
    const isComplete = checkStatus === "complete" || checkStatus === "skipped";
    const isSkipped = checkStatus === "skipped";
    const isCheckMissing = checkStatus === "missing_check";
    const isCheckError = checkStatus === "error";

    let state: "running" | "complete" | "failed" | "warning" | "pending" =
      "pending";
    let label = autoSetupOverlayActive ? "Queued" : "Waiting";

    if (isRunning) {
      state = "running";
      label = "Running";
    } else if (isComplete) {
      state = "complete";
      label = isSkipped ? "Skipped" : "Complete";
    } else if (isFailed) {
      state = "failed";
      label = "Needs attention";
    } else if (autoSetupOverlayActive) {
      state = "pending";
      label = "Queued";
    } else if (isCheckMissing) {
      state = "warning";
      label = "Missing check";
    } else if (isCheckError) {
      state = "failed";
      label = "Needs attention";
    }

    return { step, index, state, label };
  });
  const autoSetupStatusMeta: Record<
    "running" | "complete" | "failed" | "warning" | "pending",
    { icon: LucideIcon; iconClass: string; labelClass: string }
  > = {
    running: {
      icon: Loader2,
      iconClass: "text-sky-500 animate-spin",
      labelClass: "text-sky-700",
    },
    complete: {
      icon: CheckCircle2,
      iconClass: "text-emerald-500",
      labelClass: "text-emerald-700",
    },
    failed: {
      icon: AlertCircle,
      iconClass: "text-destructive",
      labelClass: "text-destructive",
    },
    warning: {
      icon: AlertCircle,
      iconClass: "text-amber-500",
      labelClass: "text-amber-700",
    },
    pending: {
      icon: Circle,
      iconClass: "text-muted-foreground/60",
      labelClass: "text-muted-foreground",
    },
  };

  return (
    <div className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {activeApp ? (
        <div>
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
                {activeApp.launch.container ? (
                  <div className="flex items-center gap-1.5 text-[11px]">
                    <button
                      type="button"
                      className="font-medium text-muted-foreground underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground"
                      onClick={() => setContainerLogsOpen(true)}
                    >
                      {containerActivityMessage}
                    </button>
                    <span
                      className={`inline-flex h-2 w-2 rounded-full ${containerActivity.dotClass}`}
                      title={containerActivity.title}
                      aria-hidden="true"
                    />
                  </div>
                ) : null}
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
                      !secretsOk ||
                      isLaunching ||
                      autoSetupActive ||
                      isSetupInstalling ||
                      isStepRunning ||
                      isTeardownRunning
                    }
                  >
                    <Play className="h-4 w-4" />
                    {autoSetupActive
                      ? "Setting up..."
                      : isLaunching
                        ? "Starting..."
                        : "Start"}
                  </Button>
                )}
              </div>
            </div>
            <div className="space-y-2 pt-0">
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
              {autoSetupFailure ? (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{autoSetupFailure}</AlertDescription>
                </Alert>
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
          <Dialog open={containerLogsOpen} onOpenChange={setContainerLogsOpen}>
            <DialogContent className="max-w-3xl">
              <DialogHeader>
                <DialogTitle>Container logs</DialogTitle>
                <DialogDescription>
                  Live output from the dev container build and run steps.
                </DialogDescription>
              </DialogHeader>
              <ScrollArea className="max-h-[70vh] rounded-md border border-border/60 bg-muted/20">
                <pre className="p-4 text-xs font-mono leading-relaxed whitespace-pre-wrap">
                  {activeContainerLogs.length > 0
                    ? activeContainerLogs.slice(-400).join("\n")
                    : "No logs yet."}
                </pre>
              </ScrollArea>
            </DialogContent>
          </Dialog>
          <Dialog open={autoSetupOverlayActive} onOpenChange={() => {}}>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>Setting things up</DialogTitle>
                <DialogDescription>
                  We found setup steps that are not done yet. Falck is taking
                  care of them now. You do not need to do anything.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
                  <div className="flex items-start gap-2">
                    <Loader2 className="mt-0.5 h-3.5 w-3.5 animate-spin text-sky-600" />
                    <div>
                      <p className="text-sm font-semibold">
                        Automatic setup in progress
                      </p>
                      <p className="text-xs text-sky-900/80">
                        {autoSetupNote ||
                          "Running setup steps before starting the app."}
                      </p>
                    </div>
                  </div>
                </div>
                <div className="space-y-2">
                  {autoSetupChecklist.map((item) => {
                    const meta = autoSetupStatusMeta[item.state];
                    const Icon = meta.icon;
                    return (
                      <div
                        key={`${item.step.name}-${item.index}`}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 bg-muted/30 px-3 py-2"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <Icon className={`h-4 w-4 ${meta.iconClass}`} />
                          <span className="text-sm font-medium">
                            {item.step.name}
                          </span>
                          {item.step.optional ? (
                            <Badge variant="outline">Optional</Badge>
                          ) : null}
                        </div>
                        <span className={`text-xs ${meta.labelClass}`}>
                          {item.label}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <p className="text-xs text-muted-foreground">
                  We will start the app automatically once everything is ready.
                </p>
              </div>
            </DialogContent>
          </Dialog>

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

                  {setupStepsConfigured ? (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border-2 border-border bg-muted/40 px-3 py-2">
                      <div>
                        <p className="text-sm font-semibold">
                          Setup status: {setupIndicator.label}
                        </p>
                        {setupStatusMessage ? (
                          <p className="text-xs text-muted-foreground">
                            {setupStatusMessage}
                          </p>
                        ) : null}
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => checkSetupSteps(activeApp.id)}
                        disabled={activeSetupCheckLoading}
                      >
                        {activeSetupCheckLoading ? "Checking..." : "Re-check"}
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
                        <h3 className="text-sm font-semibold">Setup steps</h3>
                        <p className="text-xs text-muted-foreground">
                          Run each step in order. Checks decide what's already
                          done.
                        </p>
                      </div>
                      {setupStepsConfigured ? (
                        <Button
                          size="sm"
                          onClick={() => handleSetup(activeApp)}
                          disabled={setupRunning[activeApp.id]}
                        >
                          {setupRunning[activeApp.id]
                            ? "Running..."
                            : "Run all"}
                        </Button>
                      ) : null}
                    </div>

                    {setupStepsConfigured ? (
                      <div className="space-y-2">
                        {activeSetupSteps.map((step, index) => {
                          const stepKey = `${activeApp.id}:${index}`;
                          const actionStatus =
                            setupStepStatusByApp[activeApp.id]?.[index];
                          const isRunning =
                            actionStatus === "running" ||
                            Boolean(setupStepTeardownRunning[stepKey]);
                          const isFailed = actionStatus === "failed";
                          const checkResult = activeStepChecks[index];
                          const checkStatus = checkResult?.status;
                          const isComplete =
                            checkStatus === "complete" || checkStatus === "skipped";
                          const isCheckMissing = checkStatus === "missing_check";
                          const isCheckError = checkStatus === "error";
                          const showWarning =
                            !isRunning && !isFailed && (isCheckMissing || isCheckError);
                          const showPending =
                            !isRunning && !isFailed && !isComplete && !showWarning;
                          const runLabel = isComplete ? "Re-run" : "Run";
                          const statusMessage =
                            checkResult?.message ??
                            (checkStatus === "missing_check"
                              ? "No check configured for this step."
                              : checkStatus === "skipped"
                                ? "Skipped for this environment."
                                : checkStatus === "complete"
                                  ? "Check passed."
                                  : checkStatus === "error"
                                    ? "Check failed."
                                    : checkStatus === "incomplete"
                                      ? "Not complete yet."
                                      : "Check not run yet.");

                          return (
                            <div
                              key={`${step.name}-${index}`}
                              className="rounded-lg border-2 border-border bg-card/80 px-4 py-3"
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="flex items-center gap-2">
                                  {isRunning ? (
                                    <Loader2
                                      className="h-4 w-4 animate-spin text-muted-foreground"
                                      aria-label="Running"
                                    />
                                  ) : null}
                                  {!isRunning && isComplete ? (
                                    <CheckCircle2
                                      className="h-4 w-4 text-emerald-500"
                                      aria-label="Completed"
                                    />
                                  ) : null}
                                  {!isRunning && isFailed ? (
                                    <AlertCircle
                                      className="h-4 w-4 text-destructive"
                                      aria-label="Failed"
                                    />
                                  ) : null}
                                  {!isRunning && !isFailed && showWarning ? (
                                    <AlertCircle
                                      className={`h-4 w-4 ${
                                        isCheckError
                                          ? "text-destructive"
                                          : "text-amber-500"
                                      }`}
                                      aria-label="Needs attention"
                                    />
                                  ) : null}
                                  {!isRunning && showPending ? (
                                    <Circle
                                      className="h-4 w-4 text-muted-foreground/60"
                                      aria-label="Pending"
                                    />
                                  ) : null}
                                  <span className="text-sm font-medium">
                                    {step.name}
                                  </span>
                                </div>
                                <div className="flex flex-wrap items-center gap-2">
                                  {step.optional && (
                                    <Badge variant="outline">Optional</Badge>
                                  )}
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() =>
                                      runSetupStepWithState(activeApp, index)
                                    }
                                    disabled={
                                      isRunning ||
                                      setupRunning[activeApp.id] ||
                                      autoSetupActive
                                    }
                                  >
                                    {isRunning && !setupStepTeardownRunning[stepKey]
                                      ? "Running..."
                                      : runLabel}
                                  </Button>
                                  {step.teardown ? (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      onClick={() =>
                                        runSetupStepTeardown(activeApp, index)
                                      }
                                      disabled={
                                        isRunning ||
                                        setupRunning[activeApp.id] ||
                                        autoSetupActive
                                      }
                                    >
                                      {setupStepTeardownRunning[stepKey]
                                        ? "Tearing down..."
                                        : "Teardown"}
                                    </Button>
                                  ) : null}
                                </div>
                              </div>
                              {step.description && (
                                <p className="text-xs text-muted-foreground mt-1">
                                  {step.description}
                                </p>
                              )}
                              {statusMessage ? (
                                <p className="mt-1 text-[11px] text-muted-foreground">
                                  {statusMessage}
                                </p>
                              ) : null}
                              {step.check?.description && (
                                <p className="mt-1 text-[11px] text-muted-foreground">
                                  Check: {step.check.description}
                                </p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="rounded-lg border-2 border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
                        No setup steps configured.
                      </div>
                    )}

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
