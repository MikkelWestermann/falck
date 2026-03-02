import { invoke, isTauri } from "@tauri-apps/api/core";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { confirm, message } from "@tauri-apps/plugin-dialog";

export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "installing"
  | "restarting"
  | "installed"
  | "up-to-date"
  | "error"
  | "unsupported";

export interface UpdateProgress {
  downloaded: number;
  total?: number;
  percent?: number;
}

export interface UpdateState {
  phase: UpdatePhase;
  version?: string;
  notes?: string;
  date?: string;
  message?: string;
  progress?: UpdateProgress;
}

export interface UpdateFlowOptions {
  userInitiated?: boolean;
  onState?: (state: UpdateState) => void;
}

const UPDATER_TITLE = "Falck Updates";

const formatError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

const reportState = (
  onState: UpdateFlowOptions["onState"],
  state: UpdateState,
) => {
  onState?.(state);
  return state;
};

const handleDownloadEvent = (
  event: DownloadEvent,
  version: string,
  progress: UpdateProgress,
  onState: UpdateFlowOptions["onState"],
) => {
  if (event.event === "Started") {
    progress.downloaded = 0;
    progress.total = event.data.contentLength;
    progress.percent = progress.total ? 0 : undefined;
    reportState(onState, { phase: "downloading", version, progress: { ...progress } });
    return;
  }

  if (event.event === "Progress") {
    progress.downloaded += event.data.chunkLength;
    if (progress.total && progress.total > 0) {
      progress.percent = Math.min(
        100,
        Math.round((progress.downloaded / progress.total) * 100),
      );
    }
    reportState(onState, { phase: "downloading", version, progress: { ...progress } });
    return;
  }

  if (event.event === "Finished") {
    reportState(onState, { phase: "installing", version });
  }
};

const requestRestart = async () => {
  await invoke("restart_app");
};

export const runUpdateFlow = async (
  options: UpdateFlowOptions = {},
): Promise<UpdateState> => {
  const { userInitiated = false, onState } = options;

  if (!isTauri()) {
    return reportState(onState, {
      phase: "unsupported",
      message: "Updates are only available in the desktop app.",
    });
  }

  if (import.meta.env.DEV) {
    if (userInitiated) {
      await message("Updates are disabled in development builds.", {
        title: UPDATER_TITLE,
      });
    }
    return reportState(onState, {
      phase: "unsupported",
      message: "Updates are disabled in development builds.",
    });
  }

  reportState(onState, { phase: "checking" });

  let update: Update | null = null;
  try {
    update = await check();

    if (!update) {
      if (userInitiated) {
        await message("You are already on the latest version.", {
          title: UPDATER_TITLE,
        });
      }
      return reportState(onState, { phase: "up-to-date" });
    }

    const availableUpdate = update;

    reportState(onState, {
      phase: "available",
      version: availableUpdate.version,
      notes: availableUpdate.body ?? undefined,
      date: availableUpdate.date ?? undefined,
    });

    const shouldInstall = await confirm(
      `Update ${availableUpdate.version} is available. Install now?`,
      { title: UPDATER_TITLE, kind: "info" },
    );

    if (!shouldInstall) {
      return reportState(onState, {
        phase: "available",
        version: availableUpdate.version,
        notes: availableUpdate.body ?? undefined,
        date: availableUpdate.date ?? undefined,
        message: "Update available.",
      });
    }

    const progress: UpdateProgress = { downloaded: 0 };
    reportState(onState, { phase: "downloading", version: availableUpdate.version });
    await availableUpdate.downloadAndInstall((event) => {
      handleDownloadEvent(event, availableUpdate.version, progress, onState);
    });

    reportState(onState, {
      phase: "restarting",
      version: availableUpdate.version,
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await requestRestart();
      return reportState(onState, {
        phase: "restarting",
        version: availableUpdate.version,
      });
    } catch (error) {
      console.warn("Failed to restart after update:", error);

      const fallbackMessage =
        "Automatic restart failed. Please restart Falck to apply the update.";
      if (userInitiated) {
        await message(fallbackMessage, {
          title: UPDATER_TITLE,
          kind: "info",
        });
      }

      return reportState(onState, {
        phase: "installed",
        version: availableUpdate.version,
        message: fallbackMessage,
      });
    }
  } catch (error) {
    const messageText = formatError(error);
    console.error("Update check failed:", error);

    if (userInitiated) {
      await message(`Update check failed: ${messageText}`, {
        title: UPDATER_TITLE,
        kind: "error",
      });
    }

    return reportState(onState, { phase: "error", message: messageText });
  } finally {
    if (update) {
      try {
        await update.close();
      } catch (error) {
        console.warn("Failed to close update resource:", error);
      }
    }
  }
};
