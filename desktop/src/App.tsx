import { RouterProvider, createRouter } from "@tanstack/react-router";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { routeTree } from "./routeTree.gen";
import { runUpdateFlow, type UpdateState } from "@/lib/updates";
import { UpdateProgressOverlay } from "@/components/UpdateProgressOverlay";

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export default function App() {
  const [updateState, setUpdateState] = useState<UpdateState>({
    phase: "idle",
  });

  const checkForUpdates = useCallback(async (userInitiated = false) => {
    const finalState = await runUpdateFlow({
      userInitiated,
      onState: (state) => setUpdateState(state),
    });
    setUpdateState(finalState);
  }, []);

  useEffect(() => {
    void checkForUpdates(false);
  }, [checkForUpdates]);

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
  }, [checkForUpdates]);

  return (
    <>
      <UpdateProgressOverlay state={updateState} />
      <RouterProvider router={router} />
    </>
  );
}
