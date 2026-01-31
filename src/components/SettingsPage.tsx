import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { OpenCodeSettingsPanel } from "@/components/OpenCodeSettings";
import { SSHKey } from "@/services/sshService";

interface SettingsPageProps {
  sshKey: SSHKey;
  onManageSSHKey: () => void;
  onClose: () => void;
}

export function SettingsPage({
  sshKey,
  onManageSSHKey,
  onClose,
}: SettingsPageProps) {
  return (
    <div className="relative min-h-screen bg-background text-foreground">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-24 right-0 h-72 w-72 rounded-full bg-secondary/25 blur-3xl" />
        <div className="absolute left-[-80px] top-40 h-72 w-72 rounded-full bg-primary/20 blur-3xl" />
        <div className="absolute inset-x-0 top-28 h-px bg-gradient-to-r from-transparent via-border to-transparent opacity-60" />
      </div>
      <header className="relative z-10 border-b-2 border-border/80 bg-card/80 backdrop-blur">
        <div
          className="absolute inset-x-0 top-0 z-20 h-8 cursor-grab bg-gradient-to-b from-foreground/10 to-transparent"
          data-tauri-drag-region
        />
        <div className="mx-auto w-full max-w-5xl px-6 py-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.4em] text-muted-foreground">
                Settings
              </p>
              <p className="text-sm text-muted-foreground">
                Manage SSH keys and AI providers.
              </p>
            </div>
            <div data-tauri-drag-region="false">
              <Button variant="outline" onClick={onClose}>
                Back
              </Button>
            </div>
          </div>
        </div>
      </header>

      <main className="relative z-10 mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-8">
        <Card>
          <CardHeader>
            <CardTitle>SSH key</CardTitle>
            <CardDescription>Used for all Git operations.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm">
              <div className="font-semibold">{sshKey.name}</div>
              <div className="text-xs font-mono text-muted-foreground">
                {sshKey.fingerprint}
              </div>
            </div>
            <Button variant="outline" onClick={onManageSSHKey}>
              Manage SSH key
            </Button>
          </CardContent>
        </Card>

        <OpenCodeSettingsPanel />
      </main>
    </div>
  );
}
