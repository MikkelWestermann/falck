import { RouterProvider, createRouter } from "@tanstack/react-router";
import { isTauri } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import { useEffect } from "react";
import { routeTree } from "./routeTree.gen";

const router = createRouter({ routeTree });

const checkForUpdates = async () => {
  if (!isTauri() || import.meta.env.DEV) {
    return;
  }

  try {
    const update = await check();
    if (!update) {
      return;
    }

    const shouldInstall = window.confirm(
      `Update ${update.version} is available. Install now?`,
    );

    if (!shouldInstall) {
      await update.close();
      return;
    }

    await update.downloadAndInstall();
    window.alert("Update installed. Restart Falck to apply it.");
  } catch (error) {
    console.error("Update check failed:", error);
  }
};

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export default function App() {
  useEffect(() => {
    void checkForUpdates();
  }, []);

  return <RouterProvider router={router} />;
}
