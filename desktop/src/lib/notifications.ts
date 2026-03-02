import { isTauri } from "@tauri-apps/api/core";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

type PermissionState = "unknown" | "granted" | "denied";

let permissionState: PermissionState = "unknown";
let permissionPromise: Promise<boolean> | null = null;

const ensurePermission = async () => {
  if (!isTauri()) {
    return false;
  }
  if (permissionState === "granted") {
    return true;
  }
  if (permissionState === "denied") {
    return false;
  }
  if (permissionPromise) {
    return permissionPromise;
  }

  permissionPromise = (async () => {
    try {
      let granted = await isPermissionGranted();
      if (!granted) {
        const status = await requestPermission();
        granted = status === "granted";
      }
      permissionState = granted ? "granted" : "denied";
      return granted;
    } catch {
      permissionState = "denied";
      return false;
    } finally {
      permissionPromise = null;
    }
  })();

  return permissionPromise;
};

export const notifyUser = async (title: string, body?: string) => {
  if (!title) {
    return false;
  }
  const granted = await ensurePermission();
  if (!granted) {
    return false;
  }
  try {
    sendNotification({ title, body });
    return true;
  } catch {
    return false;
  }
};
