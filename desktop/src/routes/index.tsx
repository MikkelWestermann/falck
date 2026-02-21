import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { SetupWizard } from "@/components/SetupWizard";
import { useAppState } from "@/router/app-state";
import { configService } from "@/services/configService";

export const Route = createFileRoute("/")({
  component: IndexRoute,
});

function IndexRoute() {
  const { sshKey, repoPath } = useAppState();
  const [setupCompleted, setSetupCompleted] = useState(() =>
    configService.getSetupCompleted(),
  );

  const hasExistingSetup = Boolean(repoPath);
  const effectiveSetupCompleted = setupCompleted || hasExistingSetup;

  useEffect(() => {
    if (!setupCompleted && hasExistingSetup) {
      configService.setSetupCompleted(true);
      setSetupCompleted(true);
    }
  }, [hasExistingSetup, setupCompleted]);

  if (!effectiveSetupCompleted) {
    return (
      <SetupWizard
        onComplete={() => {
          configService.setSetupCompleted(true);
          setSetupCompleted(true);
        }}
      />
    );
  }

  if (!sshKey) {
    return <Navigate to="/ssh" />;
  }

  if (!repoPath) {
    return <Navigate to="/repo" />;
  }

  return <Navigate to="/overview" />;
}
