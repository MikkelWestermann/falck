import { createFileRoute, Navigate } from "@tanstack/react-router";
import { SSHKeySetup } from "@/components/ssh/SSHKeySetup";
import { useAppState } from "@/router/app-state";

export const Route = createFileRoute("/ssh")({
  component: SSHRoute,
});

function SSHRoute() {
  const navigate = Route.useNavigate();
  const { sshKey, setSshKey, repoPath } = useAppState();

  if (sshKey) {
    return <Navigate to={repoPath ? "/overview" : "/repo"} />;
  }

  return (
    <SSHKeySetup
      onConfigured={(key) => {
        setSshKey(key);
        navigate({ to: "/repo" });
      }}
    />
  );
}
