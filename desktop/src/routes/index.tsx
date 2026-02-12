import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useAppState } from "@/router/app-state";

export const Route = createFileRoute("/")({
  component: IndexRoute,
});

function IndexRoute() {
  const { sshKey, repoPath } = useAppState();

  if (!sshKey) {
    return <Navigate to="/ssh" />;
  }

  if (!repoPath) {
    return <Navigate to="/repo" />;
  }

  return <Navigate to="/overview" />;
}
