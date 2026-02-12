import { createFileRoute, Navigate, Outlet } from "@tanstack/react-router";
import { useAppState } from "@/router/app-state";

export const Route = createFileRoute("/create")({
  component: CreateLayout,
});

function CreateLayout() {
  const { sshKey } = useAppState();

  if (!sshKey) {
    return <Navigate to="/ssh" />;
  }

  return <Outlet />;
}
