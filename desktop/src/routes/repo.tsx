import { createFileRoute, Navigate } from "@tanstack/react-router";
import { RepoSelector } from "@/components/RepoSelector";
import { useAppState } from "@/router/app-state";

export const Route = createFileRoute("/repo")({
  component: RepoRoute,
});

function RepoRoute() {
  const navigate = Route.useNavigate();
  const { sshKey, setRepoPath } = useAppState();

  if (!sshKey) {
    return <Navigate to="/ssh" />;
  }

  return (
    <RepoSelector
      onRepoSelect={(path) => {
        setRepoPath(path);
        navigate({ to: "/overview" });
      }}
      onOpenSettings={() => navigate({ to: "/settings" })}
      onCreateProject={() => navigate({ to: "/create" })}
    />
  );
}
