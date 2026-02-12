import { createFileRoute, Navigate } from "@tanstack/react-router";
import { SSHKeySetup } from "@/components/ssh/SSHKeySetup";
import { useAppState } from "@/router/app-state";

export const Route = createFileRoute("/settings/ssh")({
  component: SettingsSSHRoute,
});

function SettingsSSHRoute() {
  const navigate = Route.useNavigate();
  const { sshKey, setSshKey } = useAppState();

  if (!sshKey) {
    return <Navigate to="/ssh" />;
  }

  return (
    <SSHKeySetup
      mode="manage"
      initialKey={sshKey}
      onConfigured={(key) => setSshKey(key)}
      onClose={() => navigate({ to: "/settings" })}
    />
  );
}
