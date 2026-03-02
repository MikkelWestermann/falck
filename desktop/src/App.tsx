import { RouterProvider, createRouter } from "@tanstack/react-router";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { routeTree } from "./routeTree.gen";
import { runUpdateFlow } from "@/lib/updates";

const router = createRouter({ routeTree });

const checkForUpdates = async (userInitiated = false) => {
  await runUpdateFlow({ userInitiated });
};

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export default function App() {
  useEffect(() => {
    void checkForUpdates(false);
  }, []);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }

    let unlisten: (() => void) | undefined;

    void (async () => {
      unlisten = await listen("falck://check-for-updates", () => {
        void checkForUpdates(true);
      });
    })();

    return () => {
      unlisten?.();
    };
  }, []);

  return <RouterProvider router={router} />;
}
