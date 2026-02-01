import { createFileRoute, Navigate, Outlet } from "@tanstack/react-router";
import { useAppState } from "@/router/app-state";

export const Route = createFileRoute("/settings")({
  component: SettingsLayout,
});

function SettingsLayout() {
  const { sshKey } = useAppState();

  if (!sshKey) {
    return <Navigate to="/ssh" />;
  }

  return <Outlet />;
}
