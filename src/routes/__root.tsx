import { createRootRoute, Outlet } from "@tanstack/react-router";
import { OpenCodeManager } from "@/components/OpenCodeManager";
import { AIChatProvider } from "@/contexts/AIChatContext";
import { AppStateProvider, useAppState } from "@/router/app-state";

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFound,
});

function RootLayout() {
  return (
    <AppStateProvider>
      <RootGate />
    </AppStateProvider>
  );
}

function RootGate() {
  const { sshReady, repoPath } = useAppState();

  if (!sshReady) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-page-background text-sm text-muted-foreground">
        Loading SSH configuration...
      </div>
    );
  }

  const content = (
    <>
      <OpenCodeManager />
      <Outlet />
    </>
  );

  return repoPath ? (
    <AIChatProvider repoPath={repoPath}>{content}</AIChatProvider>
  ) : (
    content
  );
}

function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-page-background text-sm text-muted-foreground">
      404 - Page not found
    </div>
  );
}
