import { createFileRoute, Navigate } from "@tanstack/react-router";
import { SettingsPage } from "@/components/SettingsPage";
import { useAppState } from "@/router/app-state";

export const Route = createFileRoute("/settings/")({
  component: SettingsIndexRoute,
});

function SettingsIndexRoute() {
  const navigate = Route.useNavigate();
  const { sshKey, repoPath } = useAppState();

  if (!sshKey) {
    return <Navigate to="/ssh" />;
  }

  return (
    <SettingsPage
      sshKey={sshKey}
      repoPath={repoPath}
      onManageSSHKey={() => navigate({ to: "/settings/ssh" })}
      onClose={() =>
        navigate({ to: repoPath ? "/overview" : "/repo" })
      }
    />
  );
}
