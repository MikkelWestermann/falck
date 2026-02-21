import { useEffect, useMemo, useState, type ReactNode } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { OpenCodeSettings } from "@/components/OpenCodeSettings";
import {
  useGithubSetup,
  useSshSetup,
  useBackendSetup,
  useOpenCodeSetup,
} from "@/components/setup/useWizardState";
import { cn } from "@/lib/utils";
import { useAppState } from "@/router/app-state";
import { BackendMode } from "@/services/backendService";
import { KeyType } from "@/services/sshService";
import logo from "@/assets/logo.png";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Cloud,
  Copy,
  Cpu,
  Github,
  KeyRound,
  Sparkles,
  Terminal,
} from "lucide-react";

type WizardStepId =
  | "welcome"
  | "github"
  | "ssh"
  | "backend"
  | "opencode"
  | "finish";

const WIZARD_STEPS: WizardStepId[] = [
  "welcome",
  "github",
  "ssh",
  "backend",
  "opencode",
  "finish",
];

const MODE_COPY: Record<BackendMode, { title: string; description: string }> = {
  host: {
    title: "On this computer",
    description: "Uses your installed tools for the fastest setup.",
  },
  virtualized: {
    title: "Managed workspace",
    description: "A clean, isolated setup with tools handled for you.",
  },
};

const KEY_TYPE_LABELS: Record<KeyType, string> = {
  ed25519: "Ed25519 (recommended)",
  rsa: "RSA 4096",
};

interface SetupWizardProps {
  onComplete: () => void;
}

export function SetupWizard({ onComplete }: SetupWizardProps) {
  const { sshKey, setSshKey } = useAppState();
  const [stepIndex, setStepIndex] = useState(0);
  const stepId = WIZARD_STEPS[stepIndex];

  const github = useGithubSetup();
  const ssh = useSshSetup({ initialKey: sshKey, setSshKey });
  const backend = useBackendSetup();
  const openCode = useOpenCodeSetup();

  const [openCodeSettingsOpen, setOpenCodeSettingsOpen] = useState(false);
  const [skipOpenCode, setSkipOpenCode] = useState(false);

  const [newKeyName, setNewKeyName] = useState("falck");
  const [newKeyType, setNewKeyType] = useState<KeyType>("ed25519");
  const [newKeyPassphrase, setNewKeyPassphrase] = useState("");
  const [newKeyConfirm, setNewKeyConfirm] = useState("");
  const [agentPassphrase, setAgentPassphrase] = useState("");
  const [sshChoice, setSshChoice] = useState<"existing" | "new" | null>(null);
  const [sshAdvancedOpen, setSshAdvancedOpen] = useState(false);
  const [sshManualMode, setSshManualMode] = useState(false);
  const [deviceCodeCopied, setDeviceCodeCopied] = useState(false);

  useEffect(() => {
    if (stepId === "github" || stepId === "ssh") {
      void github.refresh();
    }
    if (stepId === "ssh") {
      void ssh.refreshKeys();
      void ssh.refreshOs();
    }
    if (stepId === "backend") {
      void backend.refresh();
    }
    if (stepId === "opencode") {
      void openCode.refreshStatus();
      void openCode.refreshProviders();
    }
  }, [
    stepId,
    github.refresh,
    ssh.refreshKeys,
    ssh.refreshOs,
    backend.refresh,
    openCode.refreshStatus,
    openCode.refreshProviders,
  ]);

  useEffect(() => {
    if (stepId !== "ssh" || ssh.loading) {
      return;
    }
    if (ssh.keys.length === 0 && sshChoice !== "new") {
      setSshChoice("new");
    }
    if (ssh.selectedKey && ssh.keys.length > 0 && sshChoice === null) {
      setSshChoice("existing");
    }
  }, [stepId, ssh.loading, ssh.keys.length, ssh.selectedKey, sshChoice]);

  useEffect(() => {
    if (ssh.manualConfirmed) {
      setSshManualMode(true);
    }
  }, [ssh.manualConfirmed]);

  const openCodeInstalled = Boolean(openCode.status?.installed);
  const hasProvider = openCode.connectedProviders.length > 0;
  const openCodeReady = skipOpenCode || openCodeInstalled;
  const sshStepReady = Boolean(ssh.selectedKey);
  const sshStepComplete = ssh.keyAdded || ssh.manualConfirmed;

  const canContinue = useMemo(() => {
    switch (stepId) {
      case "welcome":
        return true;
      case "github":
        return github.connected;
      case "ssh":
        return ssh.ready;
      case "backend":
        return Boolean(backend.mode) && !backend.loading;
      case "opencode":
        return openCodeReady;
      case "finish":
        return true;
      default:
        return false;
    }
  }, [
    stepId,
    github.connected,
    ssh.ready,
    backend.mode,
    backend.loading,
    openCodeReady,
  ]);

  const hasExistingKeys = ssh.keys.length > 0;
  const showExistingChoice =
    !ssh.loading && hasExistingKeys && sshChoice === null;

  const resetSshSelection = () => {
    ssh.clearSelection();
    setSshChoice(hasExistingKeys ? null : "new");
    setSshManualMode(false);
    setSshAdvancedOpen(false);
    setNewKeyPassphrase("");
    setNewKeyConfirm("");
    setAgentPassphrase("");
  };

  const goNext = () => {
    setStepIndex((prev) => Math.min(prev + 1, WIZARD_STEPS.length - 1));
  };

  const goBack = () => {
    setStepIndex((prev) => Math.max(prev - 1, 0));
  };

  const handleAdvance = () => {
    if (!canContinue) {
      return;
    }
    if (stepId === "finish") {
      onComplete();
      return;
    }
    goNext();
  };

  return (
    <div className={cn("wizard-cinematic", `wizard-step-${stepId}`)}>
      <WizardBackdrop />
      <div className="wizard-brand wizard-brand-fixed">
        <img src={logo} alt="Falck" />
        <span>Falck</span>
      </div>

      <div className="wizard-stage">
        <WizardScene key={stepId} showBack={stepIndex > 0} onBack={goBack}>
          {stepId === "welcome" && (
            <section className="wizard-step wizard-step--welcome">
              <div className="wizard-prologue">
                <div className="wizard-prologue-copy">
                  <div className="wizard-eyebrow">Welcome</div>
                  <h1 className="wizard-title">
                    Welcome to <span>Falck</span>.
                  </h1>
                  <p className="wizard-subtitle">
                    We'll set up a few essentials together: connect GitHub, set
                    up secure access, choose where your projects run, and turn
                    on OpenCode. You can change any of this later.
                  </p>
                  <div className="wizard-cta-row">
                    <Button
                      size="lg"
                      className="wizard-cta"
                      onClick={handleAdvance}
                    >
                      Let's get started
                      <ArrowRight className="h-4 w-4" />
                    </Button>
                    <div className="wizard-caption">About 4 minutes</div>
                  </div>
                </div>
                <div className="wizard-prologue-visual">
                  <div className="wizard-portal" aria-hidden>
                    <div className="wizard-portal-ring" />
                    <div className="wizard-portal-ring ring-two" />
                    <div className="wizard-portal-core"></div>
                  </div>
                </div>
              </div>
            </section>
          )}

          {stepId === "github" && (
            <section className="wizard-step wizard-step--github">
              <div className="wizard-handshake">
                <div className="wizard-handshake-content">
                  <header className="wizard-step-header">
                    <div className="wizard-eyebrow">Step 1 · GitHub</div>
                    <h1 className="wizard-title">
                      Connect your <span>GitHub</span>
                    </h1>
                    <p className="wizard-subtitle">
                      We'll open a secure GitHub page so you can approve access.
                      Your password stays with GitHub.
                    </p>
                  </header>
                  <div className="wizard-handshake-main">
                    <div className="wizard-handshake-actions">
                      <Button
                        size="lg"
                        className="wizard-cta"
                        onClick={() => void github.connect()}
                        disabled={
                          github.working || github.checking || github.connected
                        }
                      >
                        {github.connected
                          ? "Connected"
                          : github.working
                            ? "Connecting..."
                            : "Connect GitHub"}
                      </Button>
                      {github.connected && (
                        <Button variant="outline" onClick={handleAdvance}>
                          Continue
                          <ArrowRight className="h-4 w-4" />
                        </Button>
                      )}
                      {github.connected && github.user && (
                        <div className="wizard-status-line">
                          <Check className="h-4 w-4" />
                          Connected as {github.user.login}
                        </div>
                      )}
                      {github.error && (
                        <Alert variant="destructive">
                          <AlertDescription>{github.error}</AlertDescription>
                        </Alert>
                      )}
                    </div>
                    <div className="wizard-handshake-trust">
                      <div className="wizard-trust-item">
                        <Check className="h-4 w-4" />
                        No passwords required
                      </div>
                      <div className="wizard-trust-item">
                        <Check className="h-4 w-4" />
                        Approve in your browser
                      </div>
                      <div className="wizard-trust-item">
                        <Check className="h-4 w-4" />
                        Revoke anytime
                      </div>
                    </div>
                  </div>
                </div>
                <div className="wizard-handshake-visual">
                  <div className="wizard-handshake-sigils" aria-hidden>
                    <div className="wizard-sigil">
                      <img src={logo} alt="" />
                    </div>
                    <div className="wizard-sigil">
                      <Github className="h-5 w-5" />
                    </div>
                  </div>
                  <div className="wizard-device">
                    <div className="wizard-device-beam" />
                    <div className="wizard-device-card">
                      <div className="wizard-device-block">
                        <div className="wizard-device-label">One-time code</div>
                        <button
                          type="button"
                          className="wizard-device-code-row"
                          onClick={() => {
                            const code =
                              github.device?.user_code ??
                              (github.connected ? "READY" : "FALCK");
                            void navigator.clipboard
                              .writeText(code)
                              .then(() => {
                                setDeviceCodeCopied(true);
                                setTimeout(
                                  () => setDeviceCodeCopied(false),
                                  2000,
                                );
                              });
                          }}
                          aria-label="Copy device code"
                        >
                          <span className="wizard-device-code">
                            {github.device?.user_code ??
                              (github.connected ? "READY" : "FALCK")}
                          </span>
                          {deviceCodeCopied ? (
                            <Check className="h-3.5 w-3.5 wizard-device-copy-icon" />
                          ) : (
                            <Copy className="h-3.5 w-3.5 wizard-device-copy-icon" />
                          )}
                        </button>
                        <div className="wizard-device-text">
                          {github.device
                            ? `Open ${github.device.verification_uri} and enter the code to continue.`
                            : "We'll open a secure browser page for you."}
                        </div>
                        {github.connected && (
                          <div className="wizard-device-confirm">
                            <Check className="h-4 w-4" />
                            You're connected
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="wizard-handshake-steps">
                <div className="wizard-handshake-step">
                  <div className="wizard-handshake-step-title">
                    01 Get a code
                  </div>
                  <div className="wizard-handshake-step-desc">
                    Falck asks GitHub for a one-time code.
                  </div>
                </div>
                <div className="wizard-handshake-step">
                  <div className="wizard-handshake-step-title">
                    02 Approve in your browser
                  </div>
                  <div className="wizard-handshake-step-desc">
                    Confirm the connection in your browser.
                  </div>
                </div>
                <div className="wizard-handshake-step">
                  <div className="wizard-handshake-step-title">
                    03 Come back here
                  </div>
                  <div className="wizard-handshake-step-desc">
                    We'll finish connecting and move on.
                  </div>
                </div>
              </div>
            </section>
          )}

          {stepId === "ssh" && (
            <section className="wizard-step wizard-step--ssh">
              <header className="wizard-step-header">
                <div className="wizard-eyebrow">Step 2 · Secure access</div>
                <h1 className="wizard-title">
                  Set up secure <span>access</span>
                </h1>
                <p className="wizard-subtitle">
                  We'll pick or create an SSH key so Falck can sync with GitHub
                  safely.
                </p>
              </header>
              <div className="wizard-ssh-journey">
                {!sshStepReady ? (
                  <div className="wizard-ssh-step">
                    <div className="wizard-ssh-step-head">
                      <div className="wizard-flow-badge">1</div>
                      <div className="wizard-ssh-step-copy">
                        <div className="wizard-flow-title">Choose a key</div>
                        <div className="wizard-flow-desc">
                          Use an existing key or create a new one here.
                        </div>
                      </div>
                    </div>

                    <div className="wizard-ssh-step-body">
                      {ssh.loading && (
                        <WizardPanel
                          title="Scanning for keys"
                          description="Looking for keys on this computer."
                          icon={<KeyRound className="h-4 w-4" />}
                          className="wizard-surface wizard-surface--vault wizard-ssh-card"
                        >
                          <div className="wizard-placeholder">Scanning...</div>
                        </WizardPanel>
                      )}

                      {!ssh.loading && showExistingChoice && (
                        <div className="wizard-ssh-choice">
                          <div className="wizard-ssh-choice-title">
                            We found {ssh.keys.length} SSH key
                            {ssh.keys.length === 1 ? "" : "s"}.
                          </div>
                          <div className="wizard-ssh-choice-desc">
                            Want to use one?
                          </div>
                          <div className="wizard-ssh-choice-actions">
                            <Button
                              size="lg"
                              className="wizard-cta"
                              onClick={() => setSshChoice("existing")}
                            >
                              Use an existing key
                            </Button>
                            <Button
                              variant="outline"
                              onClick={() => setSshChoice("new")}
                            >
                              Create a new key
                            </Button>
                          </div>
                        </div>
                      )}

                      {!ssh.loading && sshChoice === "existing" && (
                        <WizardPanel
                          title="Choose an existing key"
                          description="Select a key already on this computer."
                          icon={<KeyRound className="h-4 w-4" />}
                          className="wizard-surface wizard-surface--vault wizard-ssh-card"
                        >
                          {ssh.keys.length === 0 ? (
                            <div className="wizard-placeholder">
                              No keys found yet.
                            </div>
                          ) : (
                            <div className="wizard-choice-list">
                              {ssh.keys.map((key) => (
                                <button
                                  key={key.fingerprint}
                                  className={cn(
                                    "wizard-choice",
                                    ssh.selectedKey?.fingerprint ===
                                      key.fingerprint && "is-selected",
                                  )}
                                  onClick={() => ssh.selectKey(key)}
                                >
                                  <div>
                                    <div className="wizard-choice-title">
                                      {key.name}
                                    </div>
                                    <div className="wizard-choice-meta">
                                      {key.fingerprint}
                                    </div>
                                  </div>
                                  <div className="wizard-choice-tag">
                                    {key.public_key.includes("ssh-ed25519")
                                      ? "Ed25519"
                                      : "RSA"}
                                  </div>
                                </button>
                              ))}
                            </div>
                          )}
                          <div className="wizard-inline-actions">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setSshChoice("new")}
                            >
                              Create a new key instead
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => void ssh.refreshKeys()}
                            >
                              Refresh keys
                            </Button>
                          </div>
                          {ssh.error && !ssh.selectedKey && (
                            <Alert variant="destructive">
                              <AlertDescription>{ssh.error}</AlertDescription>
                            </Alert>
                          )}
                        </WizardPanel>
                      )}

                      {!ssh.loading && sshChoice === "new" && (
                        <WizardPanel
                          title="Create a new key"
                          description="Name it, add an optional passphrase, and we'll create it."
                          icon={<Sparkles className="h-4 w-4" />}
                          className="wizard-surface wizard-surface--forge wizard-ssh-card"
                        >
                          <div className="wizard-form">
                            <div className="wizard-field">
                              <Label htmlFor="wizard-key-name">Key name</Label>
                              <Input
                                id="wizard-key-name"
                                value={newKeyName}
                                onChange={(event) =>
                                  setNewKeyName(event.target.value)
                                }
                                placeholder="falck"
                              />
                            </div>
                            <div className="wizard-field">
                              <Label htmlFor="wizard-key-pass">
                                Passphrase (optional)
                              </Label>
                              <Input
                                id="wizard-key-pass"
                                type="password"
                                value={newKeyPassphrase}
                                onChange={(event) =>
                                  setNewKeyPassphrase(event.target.value)
                                }
                              />
                            </div>
                            {newKeyPassphrase && (
                              <div className="wizard-field">
                                <Label htmlFor="wizard-key-confirm">
                                  Confirm passphrase
                                </Label>
                                <Input
                                  id="wizard-key-confirm"
                                  type="password"
                                  value={newKeyConfirm}
                                  onChange={(event) =>
                                    setNewKeyConfirm(event.target.value)
                                  }
                                />
                              </div>
                            )}
                          </div>
                          <button
                            type="button"
                            className="wizard-advanced-toggle"
                            onClick={() => setSshAdvancedOpen((prev) => !prev)}
                            aria-expanded={sshAdvancedOpen}
                          >
                            {sshAdvancedOpen
                              ? "Hide advanced options"
                              : "Show advanced options"}
                          </button>
                          {sshAdvancedOpen && (
                            <div className="wizard-advanced-panel">
                              <Label>Key type</Label>
                              <Select
                                value={newKeyType}
                                onValueChange={(value) =>
                                  setNewKeyType(value as KeyType)
                                }
                              >
                                <SelectTrigger>
                                  <SelectValue placeholder="Select key type" />
                                </SelectTrigger>
                                <SelectContent>
                                  {Object.entries(KEY_TYPE_LABELS).map(
                                    ([value, label]) => (
                                      <SelectItem key={value} value={value}>
                                        {label}
                                      </SelectItem>
                                    ),
                                  )}
                                </SelectContent>
                              </Select>
                            </div>
                          )}
                          <div className="wizard-inline-actions">
                            <Button
                              onClick={() =>
                                void ssh.createKey({
                                  name: newKeyName,
                                  type: newKeyType,
                                  passphrase: newKeyPassphrase,
                                  confirm: newKeyConfirm,
                                })
                              }
                              disabled={ssh.creatingKey}
                              className="wizard-cta"
                            >
                              {ssh.creatingKey ? "Creating..." : "Create key"}
                            </Button>
                            {hasExistingKeys && (
                              <Button
                                variant="ghost"
                                onClick={() => setSshChoice("existing")}
                              >
                                Use an existing key
                              </Button>
                            )}
                          </div>
                          {ssh.createError && (
                            <Alert variant="destructive">
                              <AlertDescription>
                                {ssh.createError}
                              </AlertDescription>
                            </Alert>
                          )}
                        </WizardPanel>
                      )}
                    </div>
                  </div>
                ) : (
                  <div
                    className={cn(
                      "wizard-ssh-step",
                      "wizard-ssh-step--reveal",
                      sshStepComplete && "is-complete",
                    )}
                  >
                    <div className="wizard-ssh-step-head">
                      <div className="wizard-flow-badge">2</div>
                      <div className="wizard-ssh-step-copy">
                        <div className="wizard-flow-title">Add to GitHub</div>
                        <div className="wizard-flow-desc">
                          Add the public key so syncing with GitHub works
                          securely.
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="wizard-ssh-change"
                        onClick={resetSshSelection}
                      >
                        Change key
                      </Button>
                    </div>

                    <div className="wizard-ssh-step-body">
                      <div className="wizard-ssh-summary">
                        <div className="wizard-ssh-summary-label">
                          Selected key
                        </div>
                        <div className="wizard-ssh-summary-name">
                          {ssh.selectedKey?.name}
                        </div>
                        <div className="wizard-ssh-summary-meta">
                          {ssh.selectedKey?.fingerprint}
                        </div>
                      </div>

                      <WizardPanel
                        title="Add to GitHub"
                        description="We can add it for you in one click."
                        icon={<Github className="h-4 w-4" />}
                        className="wizard-surface wizard-surface--bind wizard-ssh-card"
                      >
                        <div className="wizard-bind">
                          <div>
                            <div className="wizard-choice-title">
                              {ssh.selectedKey?.name}
                            </div>
                            <div className="wizard-choice-meta">
                              {ssh.selectedKey?.fingerprint}
                            </div>
                          </div>
                          <Button
                            className="wizard-cta"
                            onClick={() => void ssh.addKeyToGithub()}
                            disabled={
                              ssh.addingKey || ssh.keyAdded || !github.connected
                            }
                          >
                            {ssh.keyAdded
                              ? "Key added"
                              : ssh.addingKey
                                ? "Uploading..."
                                : github.connected
                                  ? "Add key to GitHub"
                                  : "Connect GitHub first"}
                          </Button>
                          {ssh.keyAdded && (
                            <div className="wizard-status-line success">
                              <Check className="h-4 w-4" />
                              GitHub accepted your key.
                            </div>
                          )}
                          {ssh.error && (
                            <Alert variant="destructive">
                              <AlertDescription>{ssh.error}</AlertDescription>
                            </Alert>
                          )}
                        </div>
                      </WizardPanel>

                      <div className="wizard-ssh-manual-toggle">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setSshManualMode((prev) => !prev)}
                        >
                          {sshManualMode
                            ? "Hide manual steps"
                            : "I'll do it myself"}
                        </Button>
                      </div>

                      {sshManualMode && (
                        <WizardPanel
                          title="Add it yourself"
                          description="Copy the key, add it in GitHub, then confirm below."
                          icon={<KeyRound className="h-4 w-4" />}
                          className="wizard-surface wizard-surface--manual wizard-ssh-card"
                        >
                          <div className="wizard-manual">
                            <div className="wizard-manual-key">
                              <div className="wizard-device-label">
                                Public key
                              </div>
                              <code>{ssh.selectedKey?.public_key}</code>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => ssh.copyKey()}
                              >
                                {ssh.copyState ? "Copied" : "Copy"}
                              </Button>
                            </div>
                            {ssh.instructions && (
                              <ol className="wizard-manual-steps">
                                {ssh.instructions.steps.map((item, index) => (
                                  <li key={`${item}-${index}`}>{item}</li>
                                ))}
                              </ol>
                            )}
                            <div className="wizard-agent">
                              <Label htmlFor="wizard-agent-pass">
                                Add to SSH agent (optional)
                              </Label>
                              <div className="wizard-agent-row">
                                <Input
                                  id="wizard-agent-pass"
                                  type="password"
                                  placeholder="Optional passphrase"
                                  value={agentPassphrase}
                                  onChange={(event) =>
                                    setAgentPassphrase(event.target.value)
                                  }
                                />
                                <Button
                                  variant="outline"
                                  onClick={() =>
                                    void ssh.addToAgent(agentPassphrase)
                                  }
                                  disabled={ssh.agentWorking}
                                >
                                  {ssh.agentWorking ? "Adding..." : "Add"}
                                </Button>
                              </div>
                              {ssh.agentMessage && (
                                <div className="wizard-status-line success">
                                  <Check className="h-4 w-4" />
                                  {ssh.agentMessage}
                                </div>
                              )}
                              {ssh.agentError && (
                                <div className="wizard-status-line error">
                                  {ssh.agentError}
                                </div>
                              )}
                            </div>
                          </div>
                          <WizardToggle
                            checked={ssh.manualConfirmed}
                            onChange={(value) => ssh.setManualConfirmed(value)}
                            label="I added the key in GitHub"
                            description="Use this once GitHub shows the key."
                          />
                        </WizardPanel>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div className="wizard-step-cta">
                <Button
                  size="lg"
                  className="wizard-cta"
                  onClick={handleAdvance}
                  disabled={!ssh.ready}
                >
                  Continue
                  <ArrowRight className="h-4 w-4" />
                </Button>
                {!ssh.ready && (
                  <div className="wizard-caption">
                    Add the key to GitHub to continue.
                  </div>
                )}
              </div>
            </section>
          )}

          {stepId === "backend" && (
            <section className="wizard-step wizard-step--backend">
              <header className="wizard-step-header">
                <div className="wizard-eyebrow">Step 3 · Workspace</div>
                <h1 className="wizard-title">
                  Choose where your <span>projects</span> run
                </h1>
                <p className="wizard-subtitle">
                  Pick where Falck runs your projects by default. You can switch
                  later if your needs change.
                </p>
              </header>
              {backend.error && (
                <Alert variant="destructive">
                  <AlertDescription>{backend.error}</AlertDescription>
                </Alert>
              )}
              {backend.loading && (
                <div className="wizard-caption">Checking prerequisites...</div>
              )}
              <div className="wizard-realm-grid">
                {(["virtualized", "host"] as BackendMode[]).map((mode) => {
                  const isVirtualized = mode === "virtualized";
                  const disabled = isVirtualized && !backend.prereq?.installed;
                  return (
                    <button
                      key={mode}
                      className={cn(
                        "wizard-realm",
                        backend.mode === mode && "is-selected",
                        disabled && "is-disabled",
                      )}
                      onClick={() =>
                        disabled ? null : void backend.selectMode(mode)
                      }
                    >
                      <div className="wizard-realm-header">
                        <div className="wizard-realm-icon">
                          {isVirtualized ? (
                            <Cloud className="h-5 w-5" />
                          ) : (
                            <Cpu className="h-5 w-5" />
                          )}
                        </div>
                        <div className="wizard-realm-copy">
                          <div className="wizard-realm-title">
                            {MODE_COPY[mode].title}
                          </div>
                          <div className="wizard-realm-desc">
                            {MODE_COPY[mode].description}
                          </div>
                        </div>
                        <div className="wizard-realm-tag">
                          {isVirtualized && backend.prereq?.installed
                            ? "Recommended"
                            : disabled
                              ? `Needs ${backend.prereq?.tool ?? "setup"}`
                              : ""}
                        </div>
                      </div>
                      <ul className="wizard-realm-list">
                        <li>
                          {isVirtualized
                            ? "Clean, isolated workspace"
                            : "Uses your local tools"}
                        </li>
                        <li>
                          {isVirtualized
                            ? "Matches your team's setup"
                            : "Fast for quick changes"}
                        </li>
                      </ul>
                    </button>
                  );
                })}
              </div>
              <div className="wizard-step-cta">
                <Button
                  size="lg"
                  className="wizard-cta"
                  onClick={handleAdvance}
                  disabled={!backend.mode || backend.loading}
                >
                  Continue
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </div>
            </section>
          )}

          {stepId === "opencode" && (
            <section className="wizard-step wizard-step--opencode">
              <header className="wizard-step-header">
                <div className="wizard-eyebrow">Step 4 · OpenCode</div>
                <h1 className="wizard-title">
                  Turn on <span>OpenCode</span>
                </h1>
                <p className="wizard-subtitle">
                  OpenCode powers Falck's AI features on your computer. Install
                  it once, then connect an AI provider.
                </p>
              </header>
              <div className="wizard-opencode-journey">
                <div className="wizard-opencode-beacon" aria-hidden>
                  <div className="wizard-opencode-halo" />
                  <div className="wizard-opencode-wave" />
                  <div className="wizard-opencode-core" />
                </div>
                <div className="wizard-opencode-steps">
                  <div
                    className={cn(
                      "wizard-opencode-step",
                      openCodeInstalled && "is-complete",
                    )}
                  >
                    <div className="wizard-flow-badge">1</div>
                    <div className="wizard-opencode-step-body">
                      <div className="wizard-opencode-step-title">
                        Install OpenCode
                      </div>
                      <div className="wizard-opencode-step-desc">
                        It runs AI features on your computer, so your data stays
                        close to home.
                      </div>
                      <div
                        className={cn(
                          "wizard-opencode-install",
                          openCodeInstalled && "is-ready",
                        )}
                      >
                        <div className="wizard-status-line">
                          {openCodeInstalled ? (
                            <>
                              <Check className="h-4 w-4" />
                              OpenCode installed
                            </>
                          ) : (
                            <span>OpenCode isn't installed yet</span>
                          )}
                        </div>
                        <div className="wizard-inline-actions">
                          <Button
                            onClick={() => void openCode.install()}
                            disabled={openCode.installing}
                            className="wizard-cta"
                          >
                            {openCode.installing
                              ? "Installing..."
                              : "Install OpenCode"}
                          </Button>
                          <Button
                            variant="outline"
                            onClick={() => void openCode.refreshStatus()}
                          >
                            Check again
                          </Button>
                        </div>
                        {openCode.message && (
                          <div className="wizard-caption">
                            {openCode.message}
                          </div>
                        )}
                        {openCode.manual && (
                          <div className="wizard-caption">
                            We opened the install page in your browser. Finish
                            it there, then check again.
                          </div>
                        )}
                        {openCode.error && (
                          <Alert variant="destructive">
                            <AlertDescription>
                              {openCode.error}
                            </AlertDescription>
                          </Alert>
                        )}
                      </div>
                    </div>
                  </div>

                  <div
                    className={cn(
                      "wizard-opencode-step",
                      !openCodeInstalled && "is-locked",
                      hasProvider && "is-complete",
                    )}
                  >
                    <div className="wizard-flow-badge">2</div>
                    <div className="wizard-opencode-step-body">
                      <div className="wizard-opencode-step-title">
                        Connect an AI provider
                      </div>
                      <div className="wizard-opencode-step-desc">
                        Connect at least one AI provider so Falck can respond.
                      </div>
                      <div
                        className={cn(
                          "wizard-opencode-providers",
                          hasProvider && "is-ready",
                        )}
                      >
                        <div className="wizard-provider-grid">
                          {openCode.providerLoading ? (
                            <div className="wizard-caption">
                              Loading providers...
                            </div>
                          ) : hasProvider ? (
                            openCode.connectedProviders.map((provider) => (
                              <span
                                key={provider}
                                className="wizard-provider-chip"
                              >
                                {provider}
                              </span>
                            ))
                          ) : (
                            <div className="wizard-caption">
                              No AI providers connected yet.
                            </div>
                          )}
                        </div>
                        {openCode.providerError && (
                          <Alert variant="destructive">
                            <AlertDescription>
                              {openCode.providerError}
                            </AlertDescription>
                          </Alert>
                        )}
                        <div className="wizard-inline-actions">
                          <Button
                            variant="outline"
                            onClick={() => setOpenCodeSettingsOpen(true)}
                          >
                            Choose AI providers
                          </Button>
                          {hasProvider && (
                            <div className="wizard-status-line success">
                              <Check className="h-4 w-4" />
                              AI providers connected
                            </div>
                          )}
                        </div>
                        {!openCodeInstalled && (
                          <div className="wizard-caption">
                            You can connect providers now, then install OpenCode
                            to use them.
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div
                    className={cn(
                      "wizard-opencode-step",
                      openCodeInstalled && hasProvider && "is-complete",
                    )}
                  >
                    <div className="wizard-flow-badge">3</div>
                    <div className="wizard-opencode-step-body">
                      <div className="wizard-opencode-step-title">
                        Final check
                      </div>
                      <div className="wizard-opencode-step-desc">
                        Once these are green, Falck can use OpenCode.
                      </div>
                      <div
                        className={cn(
                          "wizard-opencode-check",
                          openCodeInstalled && hasProvider && "is-ready",
                        )}
                      >
                        <ul className="wizard-opencode-checklist">
                          <li className={cn(openCodeInstalled && "is-done")}>
                            {openCodeInstalled ? (
                              <Check className="h-4 w-4" />
                            ) : (
                              <span className="wizard-opencode-dot" />
                            )}
                            OpenCode installed
                          </li>
                          <li className={cn(hasProvider && "is-done")}>
                            {hasProvider ? (
                              <Check className="h-4 w-4" />
                            ) : (
                              <span className="wizard-opencode-dot" />
                            )}
                            AI provider connected
                          </li>
                          <li
                            className={cn(
                              openCodeInstalled && hasProvider && "is-done",
                            )}
                          >
                            {openCodeInstalled && hasProvider ? (
                              <Check className="h-4 w-4" />
                            ) : (
                              <span className="wizard-opencode-dot" />
                            )}
                            Falck ready to use OpenCode
                          </li>
                        </ul>
                        <div className="wizard-caption">
                          Falck works best with OpenCode turned on.
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="wizard-opencode-footer">
                <div className="wizard-step-cta">
                  <Button
                    size="lg"
                    className="wizard-cta"
                    onClick={handleAdvance}
                    disabled={!openCodeReady}
                  >
                    Continue
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                  {!openCodeReady && (
                    <>
                      <div className="wizard-caption">
                        Install OpenCode to continue.
                      </div>
                      <button
                        type="button"
                        className="mt-4 text-xs text-muted-foreground/70 hover:text-muted-foreground transition-colors"
                        onClick={() => {
                          setSkipOpenCode(true);
                          goNext();
                        }}
                      >
                        Skip for now
                      </button>
                    </>
                  )}
                </div>
              </div>
            </section>
          )}

          {stepId === "finish" && (
            <section className="wizard-step wizard-step--finish">
              <div className="wizard-finish-hero">
                <div className="wizard-finish-copy">
                  <div className="wizard-eyebrow">All set</div>
                  <h1 className="wizard-title">
                    You're all <span>set</span>.
                  </h1>
                  <p className="wizard-subtitle">
                    Falck has the basics in place. You're ready to start making
                    real changes.
                  </p>
                </div>
                <div className="wizard-finish-visual" aria-hidden>
                  <div className="wizard-finish-crest">
                    <div className="wizard-finish-ring" />
                    <div className="wizard-finish-ring ring-two" />
                    <div className="wizard-finish-core">
                      <Check className="h-5 w-5" />
                    </div>
                    <div className="wizard-finish-spark" />
                  </div>
                </div>
                <div className="wizard-step-cta">
                  <Button
                    size="lg"
                    className="wizard-cta"
                    onClick={handleAdvance}
                  >
                    Start building
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="wizard-summary">
                <WizardStat
                  title="GitHub"
                  value={
                    github.connected
                      ? (github.user?.login ?? "Connected")
                      : "Not connected"
                  }
                  icon={<Github className="h-4 w-4" />}
                />
                <WizardStat
                  title="SSH key"
                  value={ssh.selectedKey?.name ?? "Not set"}
                  icon={<KeyRound className="h-4 w-4" />}
                />
                <WizardStat
                  title="Workspace"
                  value={
                    backend.mode ? MODE_COPY[backend.mode].title : "Not set"
                  }
                  icon={
                    backend.mode === "virtualized" ? (
                      <Cloud className="h-4 w-4" />
                    ) : (
                      <Cpu className="h-4 w-4" />
                    )
                  }
                />
                <WizardStat
                  title="OpenCode"
                  value={
                    openCode.status?.installed
                      ? "Installed"
                      : skipOpenCode
                        ? "Skipped"
                        : "Not installed"
                  }
                  icon={<Terminal className="h-4 w-4" />}
                />
              </div>
            </section>
          )}
        </WizardScene>
      </div>

      <OpenCodeSettings
        open={openCodeSettingsOpen}
        onOpenChange={(open) => {
          setOpenCodeSettingsOpen(open);
          if (!open) {
            void openCode.refreshProviders();
          }
        }}
      />
    </div>
  );
}

function WizardBackdrop() {
  return (
    <div className="wizard-backdrop" aria-hidden>
      <div className="wizard-nebula" />
      <div className="wizard-step-layer" />
      <div className="wizard-step-layer wizard-step-layer--two" />
      <div className="wizard-stars" />
      <div className="wizard-glow" />
    </div>
  );
}

interface WizardSceneProps {
  children: ReactNode;
  showBack: boolean;
  onBack: () => void;
}

function WizardScene({ children, showBack, onBack }: WizardSceneProps) {
  return (
    <div className="wizard-scene">
      <div className="wizard-topbar">
        {showBack && (
          <Button
            variant="ghost"
            className="wizard-back normal-case tracking-normal"
            onClick={onBack}
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
        )}
      </div>
      {children}
    </div>
  );
}

interface WizardPanelProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}

function WizardPanel({
  title,
  description,
  icon,
  children,
  className,
}: WizardPanelProps) {
  return (
    <div className={cn("wizard-panel", className)}>
      <div className="wizard-panel-head">
        <div className="wizard-panel-title">
          {icon && <span className="wizard-panel-icon">{icon}</span>}
          {title}
        </div>
        {description && <div className="wizard-panel-desc">{description}</div>}
      </div>
      <div className="wizard-panel-body">{children}</div>
    </div>
  );
}

interface WizardToggleProps {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  description?: string;
}

function WizardToggle({
  checked,
  onChange,
  label,
  description,
}: WizardToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={cn("wizard-toggle", checked && "is-on")}
      onClick={() => onChange(!checked)}
    >
      <span className="wizard-toggle-indicator" />
      <span>
        <span className="wizard-toggle-label">{label}</span>
        {description && (
          <span className="wizard-toggle-desc">{description}</span>
        )}
      </span>
    </button>
  );
}

interface WizardStatProps {
  title: string;
  value: string;
  icon: ReactNode;
}

function WizardStat({ title, value, icon }: WizardStatProps) {
  return (
    <div className="wizard-stat">
      <div className="wizard-stat-icon">{icon}</div>
      <div>
        <div className="wizard-stat-title">{title}</div>
        <div className="wizard-stat-value">{value}</div>
      </div>
    </div>
  );
}
