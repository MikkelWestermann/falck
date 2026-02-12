import { useEffect, useState } from "react";
import { useForm } from "@tanstack/react-form";
import { z } from "zod";

import { FormField, FormSelect } from "@/components/form/FormField";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { configService } from "@/services/configService";
import { falckService } from "@/services/falckService";
import {
  GithubDeviceResponse,
  GithubUser,
  githubService,
} from "@/services/githubService";
import { KeyType, SSHKey, sshService } from "@/services/sshService";
import logo from "@/assets/logo.png";

type Step = "select" | "create" | "guide" | "overview";

const generateKeyBaseSchema = z.object({
  keyName: z.string().min(1, "Key name is required"),
  keyType: z.enum(["ed25519", "rsa"]),
  passphrase: z.string().optional(),
  passphraseConfirm: z.string().optional(),
});

const generateKeySchema = generateKeyBaseSchema.refine(
  (data) => !data.passphrase || data.passphrase === data.passphraseConfirm,
  {
    message: "Passphrases do not match",
    path: ["passphraseConfirm"],
  },
);

type SetupMode = "onboarding" | "manage";

interface SSHKeySetupProps {
  onConfigured: (key: SSHKey) => void;
  mode?: SetupMode;
  onClose?: () => void;
  initialKey?: SSHKey | null;
}

export function SSHKeySetup({
  onConfigured,
  mode = "onboarding",
  onClose,
  initialKey = null,
}: SSHKeySetupProps) {
  const [step, setStep] = useState<Step>(() => {
    if (mode === "manage") {
      return initialKey ? "overview" : "select";
    }
    return "select";
  });
  const [keys, setKeys] = useState<SSHKey[]>([]);
  const [loadingKeys, setLoadingKeys] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentKey, setCurrentKey] = useState<SSHKey | null>(initialKey);
  const [copied, setCopied] = useState(false);
  const [agentStatus, setAgentStatus] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [agentPassphrase, setAgentPassphrase] = useState("");
  const [addingAgent, setAddingAgent] = useState(false);
  const [githubDevice, setGithubDevice] = useState<GithubDeviceResponse | null>(
    null,
  );
  const [githubUser, setGithubUser] = useState<GithubUser | null>(null);
  const [githubConnected, setGithubConnected] = useState(false);
  const [githubWorking, setGithubWorking] = useState(false);
  const [githubKeyAdded, setGithubKeyAdded] = useState(false);
  const [githubError, setGithubError] = useState<string | null>(null);
  const [githubChecking, setGithubChecking] = useState(false);
  const isManageMode = mode === "manage";

  useEffect(() => {
    setError(null);
  }, [step]);

  useEffect(() => {
    if (step === "select") {
      void loadKeys();
    }
  }, [step]);

  useEffect(() => {
    if (step !== "guide") {
      return;
    }

    let active = true;
    setGithubChecking(true);
    setGithubError(null);
    setGithubDevice(null);
    setGithubKeyAdded(false);

    githubService
      .hasToken()
      .then((hasToken) => {
        if (!active) {
          return;
        }
        setGithubConnected(hasToken);
        if (hasToken) {
          githubService
            .getUser()
            .then((user) => {
              if (active) {
                setGithubUser(user);
              }
            })
            .catch(() => {
              if (active) {
                setGithubUser(null);
              }
            });
        } else {
          setGithubUser(null);
        }
      })
      .catch((err) => {
        if (!active) {
          return;
        }
        setGithubConnected(false);
        setGithubUser(null);
        setGithubError(`GitHub auth unavailable: ${String(err)}`);
      })
      .finally(() => {
        if (active) {
          setGithubChecking(false);
        }
      });

    return () => {
      active = false;
    };
  }, [step]);

  useEffect(() => {
    if (mode !== "manage") {
      return;
    }
    if (initialKey) {
      setCurrentKey(initialKey);
      setStep("overview");
    } else {
      setCurrentKey(null);
      setStep("select");
    }
  }, [initialKey, mode]);

  const loadKeys = async () => {
    setLoadingKeys(true);
    setError(null);
    try {
      const availableKeys = await sshService.listKeys();
      setKeys(availableKeys);
    } catch (err) {
      setError(`Failed to load SSH keys: ${String(err)}`);
    } finally {
      setLoadingKeys(false);
    }
  };


  const handleSelectKey = (key: SSHKey) => {
    setCurrentKey(key);
    setAgentStatus(null);
    setAgentError(null);
    setAgentPassphrase("");
    setGithubKeyAdded(false);
    setGithubError(null);
    setStep("guide");
  };

  const handleContinue = () => {
    if (!currentKey) {
      return;
    }
    configService.setSelectedSSHKey(currentKey);
    onConfigured(currentKey);
    if (isManageMode) {
      onClose?.();
    }
  };

  const handleCopyPublicKey = () => {
    if (!currentKey) {
      return;
    }
    navigator.clipboard.writeText(currentKey.public_key).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleAddToAgent = async (
    key: SSHKey | null,
    passphrase: string | null,
  ) => {
    if (!key) {
      return;
    }
    setAddingAgent(true);
    setAgentStatus(null);
    setAgentError(null);
    try {
      await sshService.addKeyToAgent(
        key.private_key_path,
        passphrase && passphrase.length > 0 ? passphrase : null,
      );
      setAgentStatus("Key added to SSH agent.");
    } catch (err) {
      setAgentError(`Failed to add key to SSH agent: ${String(err)}`);
    } finally {
      setAddingAgent(false);
    }
  };

  const addKeyToGithub = async () => {
    if (!currentKey) {
      return;
    }
    try {
      await githubService.addSshKey(
        `Falck - ${currentKey.name}`,
        currentKey.public_key,
      );
      setGithubKeyAdded(true);
    } catch (err) {
      const message = String(err);
      const lowered = message.toLowerCase();
      if (lowered.includes("already exists") || lowered.includes("already in use")) {
        setGithubKeyAdded(true);
        return;
      }
      throw err;
    }
  };

  const handleAddKeyToGithub = async () => {
    setGithubError(null);
    setGithubWorking(true);
    try {
      await addKeyToGithub();
    } catch (err) {
      setGithubError(`Failed to add key to GitHub: ${String(err)}`);
    } finally {
      setGithubWorking(false);
    }
  };

  const handleConnectGithub = async () => {
    setGithubError(null);
    setGithubWorking(true);
    try {
      const device = await githubService.startDeviceFlow();
      setGithubDevice(device);
      await falckService.openInBrowser(
        device.verification_uri_complete ?? device.verification_uri,
      );
      await githubService.pollDeviceToken(
        device.device_code,
        device.interval,
        device.expires_in,
      );
      setGithubConnected(true);
      setGithubDevice(null);
      try {
        const user = await githubService.getUser();
        setGithubUser(user);
      } catch {
        setGithubUser(null);
      }
      try {
        await addKeyToGithub();
      } catch (err) {
        setGithubError(`Failed to add key to GitHub: ${String(err)}`);
      }
    } catch (err) {
      setGithubConnected(false);
      setGithubDevice(null);
      setGithubError(`GitHub login failed: ${String(err)}`);
    } finally {
      setGithubWorking(false);
    }
  };

  const createForm = useForm({
    defaultValues: {
      keyName: "github",
      keyType: "ed25519" as KeyType,
      passphrase: "",
      passphraseConfirm: "",
    },
    validators: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- refined Zod schema types don't match form; runtime validation is correct
      onSubmit: generateKeySchema as any,
    },
    onSubmit: async ({ value }) => {
      setError(null);
      try {
        const key = await sshService.generateNewKey(
          value.keyName,
          value.passphrase || null,
          value.keyType,
        );
        setCurrentKey(key);
        setGithubKeyAdded(false);
        setGithubError(null);
        setStep("guide");
        await handleAddToAgent(key, value.passphrase || null);
      } catch (err) {
        setError(`Failed to generate key: ${String(err)}`);
      }
    },
  });

  if (step === "create") {
    return (
      <div className="min-h-screen bg-background">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-10">
          <Card>
            <CardHeader>
              <CardTitle>Create SSH key</CardTitle>
              <CardDescription>
                Generate a new key to authenticate with GitHub.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void createForm.handleSubmit();
                }}
                className="space-y-4"
              >
                <createForm.Field name="keyName">
                  {(field) => (
                    <FormField
                      field={field}
                      label="Key name"
                      placeholder="github"
                      required
                    />
                  )}
                </createForm.Field>
                <createForm.Field name="keyType">
                  {(field) => (
                    <FormSelect
                      field={field}
                      label="Key type"
                      options={[
                        { label: "Ed25519 (recommended)", value: "ed25519" },
                        { label: "RSA (4096 bits)", value: "rsa" },
                      ]}
                      required
                    />
                  )}
                </createForm.Field>
                <createForm.Field name="passphrase">
                  {(field) => (
                    <FormField
                      field={field}
                      label="Passphrase (optional)"
                      type="password"
                      placeholder="Leave empty for no passphrase"
                    />
                  )}
                </createForm.Field>
                <createForm.Field name="passphraseConfirm">
                  {(field) => (
                    <FormField
                      field={field}
                      label="Confirm passphrase"
                      type="password"
                      placeholder="Re-enter passphrase"
                    />
                  )}
                </createForm.Field>

                {error && (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}

                <div className="flex gap-3">
                  <Button
                    variant="outline"
                    type="button"
                    onClick={() => setStep("select")}
                  >
                    Back
                  </Button>
                  <Button type="submit" className="flex-1">
                    Generate key
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (step === "overview" && currentKey) {
    return (
      <div className="min-h-screen bg-background">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-10">
          <Card>
            <CardHeader>
              <CardTitle>SSH key settings</CardTitle>
              <CardDescription>
                Review the active key or switch to another one.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg border-2 border-border bg-secondary/10 p-4 text-sm">
                <div className="text-muted-foreground">Current key</div>
                <div className="mt-1 text-lg font-semibold">{currentKey.name}</div>
                <div className="mt-2 text-xs font-mono text-muted-foreground">
                  {currentKey.fingerprint}
                </div>
              </div>

              <div className="flex flex-wrap gap-3">
                <Button onClick={() => setStep("guide")} className="flex-1">
                  View setup guide
                </Button>
                <Button variant="outline" onClick={() => setStep("select")}>
                  Change key
                </Button>
              </div>

              {onClose && (
                <Button
                  variant="ghost"
                  className="w-full"
                  onClick={() => onClose()}
                >
                  Back to app
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (step === "guide" && currentKey) {
    return (
      <div className="min-h-screen bg-background">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-10">
          <Card>
            <CardHeader>
              <CardTitle>SSH key created</CardTitle>
              <CardDescription>
                Add it to GitHub so Falck can authenticate Git operations.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="rounded-lg border-2 border-primary/40 bg-primary/5 p-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="space-y-2">
                    <Badge variant="secondary">Recommended</Badge>
                    <div className="text-lg font-semibold">
                      Upload with GitHub
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Connect your GitHub account and Falck will add the SSH key
                      automatically.
                    </p>
                  </div>
                  {githubConnected ? (
                    <div className="flex flex-wrap items-center gap-2">
                      {githubKeyAdded ? (
                        <Badge variant="secondary">Key added</Badge>
                      ) : (
                        <Button
                          onClick={() => void handleAddKeyToGithub()}
                          disabled={githubWorking}
                        >
                          {githubWorking ? "Uploading…" : "Upload key"}
                        </Button>
                      )}
                    </div>
                  ) : (
                    <Button
                      onClick={() => void handleConnectGithub()}
                      disabled={githubWorking || githubChecking}
                    >
                      {githubWorking ? "Connecting…" : "Connect GitHub"}
                    </Button>
                  )}
                </div>

                {githubConnected && githubUser && (
                  <div className="mt-3 text-xs text-muted-foreground">
                    Connected as{" "}
                    <span className="font-semibold text-foreground">
                      {githubUser.login}
                    </span>
                    . Manage this connection in Settings.
                  </div>
                )}

                {githubDevice && (
                  <Alert className="mt-4">
                    <AlertDescription>
                      Visit{" "}
                      <span className="font-semibold">
                        {githubDevice.verification_uri}
                      </span>{" "}
                      and enter code{" "}
                      <span className="font-mono font-semibold">
                        {githubDevice.user_code}
                      </span>
                      .
                    </AlertDescription>
                  </Alert>
                )}

                {githubError && (
                  <Alert variant="destructive" className="mt-4">
                    <AlertDescription>{githubError}</AlertDescription>
                  </Alert>
                )}
              </div>

              <details className="rounded-lg border-2 border-border bg-card p-4">
                <summary className="cursor-pointer font-semibold">
                  Or copy/paste manually
                </summary>
                <div className="mt-4 space-y-4">
                  <div className="rounded-lg border-2 border-border bg-card p-4">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <div className="text-sm text-muted-foreground">
                          Step 1
                        </div>
                        <div className="text-base font-semibold">
                          Copy your public key
                        </div>
                      </div>
                      <Button
                        variant="outline"
                        onClick={handleCopyPublicKey}
                        className="shrink-0"
                      >
                        {copied ? "Copied!" : "Copy key"}
                      </Button>
                    </div>
                    <details className="mt-3 text-xs text-muted-foreground">
                      <summary className="cursor-pointer">Show key</summary>
                      <code className="mt-2 block max-h-32 overflow-auto rounded bg-muted p-3 text-xs break-all">
                        {currentKey.public_key}
                      </code>
                    </details>
                  </div>

                  <div className="rounded-lg border-2 border-border bg-card p-4">
                    <div className="text-sm text-muted-foreground">Step 2</div>
                    <div className="text-base font-semibold">
                      Open GitHub settings
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">
                      GitHub → Settings → SSH and GPG keys → New SSH key
                    </p>
                  </div>

                  <div className="rounded-lg border-2 border-border bg-card p-4">
                    <div className="text-sm text-muted-foreground">Step 3</div>
                    <div className="text-base font-semibold">
                      Paste and save
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">
                      Paste the key you copied and click “Add SSH key”.
                    </p>
                  </div>
                </div>
              </details>

              <details className="rounded-lg border-2 border-border bg-secondary/10 p-4 text-sm">
                <summary className="cursor-pointer font-semibold">
                  Advanced options
                </summary>
                <div className="mt-4 grid gap-4">
                  <div>
                    <div className="text-xs text-muted-foreground">
                      Key fingerprint
                    </div>
                    <div className="mt-1 font-mono text-xs">
                      {currentKey.fingerprint}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">
                      Private key location
                    </div>
                    <div className="mt-1 font-mono text-xs">
                      {currentKey.private_key_path}
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="agent-passphrase">Add to SSH agent</Label>
                    <Input
                      id="agent-passphrase"
                      type="password"
                      value={agentPassphrase}
                      onChange={(event) =>
                        setAgentPassphrase(event.target.value)
                      }
                      placeholder="Optional passphrase"
                    />
                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={() =>
                        void handleAddToAgent(
                          currentKey,
                          agentPassphrase.length ? agentPassphrase : null,
                        )
                      }
                      disabled={addingAgent}
                    >
                      {addingAgent ? "Adding…" : "Add to SSH agent"}
                    </Button>
                    {agentStatus && (
                      <Alert>
                        <AlertDescription>{agentStatus}</AlertDescription>
                      </Alert>
                    )}
                    {agentError && (
                      <Alert variant="destructive">
                        <AlertDescription>{agentError}</AlertDescription>
                      </Alert>
                    )}
                  </div>
                </div>
              </details>

              <div className="flex flex-wrap gap-3">
                <Button
                  variant="outline"
                  onClick={() => (isManageMode ? setStep("overview") : setStep("select"))}
                >
                  {isManageMode ? "Back" : "Choose different key"}
                </Button>
                <Button onClick={handleContinue} className="flex-1">
                  {isManageMode ? "Save and return" : "Continue to repositories"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-10">
        <header className="relative overflow-hidden border-2 border-border bg-card pr-6 pl-16 py-7 shadow-[var(--shadow-lg)]">
          <div className="absolute inset-x-0 top-0 h-2 bg-primary" />
          <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
            <div className="flex items-start gap-4">
              <div className="flex h-12 w-12 items-center justify-center border-2 border-border bg-primary shadow-[var(--shadow-sm)]">
                <img
                  src={logo}
                  alt="Falck logo"
                  className="h-7 w-7 object-contain"
                />
              </div>
              <div className="max-w-2xl space-y-3">
                <p className="text-xs font-semibold uppercase tracking-[0.4em] text-foreground">
                  Falck
                </p>
                <h1 className="text-3xl font-black uppercase leading-tight tracking-tight md:text-4xl">
                  Connect with SSH
                </h1>
                <p className="text-base text-muted-foreground">
                  Set up an SSH key so Git operations can authenticate securely.
                </p>
              </div>
            </div>
            <div className="grid gap-2 text-right">
              <Badge variant="secondary" className="justify-center">
                Secure Git
              </Badge>
              <Badge variant="secondary" className="justify-center">
                Required step
              </Badge>
              <Badge variant="secondary" className="justify-center">
                2 minutes
              </Badge>
            </div>
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <Card>
            <CardHeader>
              <CardTitle>Select an existing key</CardTitle>
              <CardDescription>
                Choose a key already in your ~/.ssh folder.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {loadingKeys ? (
                <div className="rounded-lg border-2 border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
                  Loading keys…
                </div>
              ) : keys.length === 0 ? (
                <div className="rounded-lg border-2 border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
                  No SSH keys found yet.
                </div>
              ) : (
                <div className="space-y-3">
                  {keys.map((key) => (
                    <button
                      key={key.fingerprint}
                      className="flex w-full flex-col gap-2 rounded-lg border-2 border-border bg-card/70 px-4 py-3 text-left shadow-[var(--shadow-xs)] transition hover:bg-secondary/20 active:shadow-none"
                      onClick={() => handleSelectKey(key)}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold">{key.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {key.fingerprint}
                          </div>
                        </div>
                        <Badge variant="outline" className="text-xs">
                          {key.public_key.includes("ssh-ed25519")
                            ? "Ed25519"
                            : "RSA"}
                        </Badge>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              <div className="flex gap-2">
                <Button variant="outline" onClick={() => void loadKeys()}>
                  Refresh
                </Button>
                <Button onClick={() => setStep("create")} className="flex-1">
                  Create new key
                </Button>
                {isManageMode && (
                  <Button variant="ghost" onClick={() => setStep("overview")}>
                    Cancel
                  </Button>
                )}
              </div>

              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Why this matters</CardTitle>
              <CardDescription>Falck uses SSH keys for all Git actions.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>
                SSH keys keep your GitHub account secure and let Falck push, pull,
                and clone without asking for passwords.
              </p>
              <p>
                If you already have a key, select it. Otherwise, generate a new
                one right here and add the public key to GitHub.
              </p>
              <Alert>
                <AlertDescription>
                  Once your key is added to GitHub, you can continue to repositories.
                </AlertDescription>
              </Alert>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
