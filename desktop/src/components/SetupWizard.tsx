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
import { useGithubSetup, useSshSetup, useBackendSetup, useOpenCodeSetup } from "@/components/setup/useWizardState";
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
    description: "Fast, direct execution with local dependencies.",
  },
  virtualized: {
    title: "Virtual workspace",
    description: "Clean, isolated environments with managed tooling.",
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

  const openCodeReady = skipOpenCode || Boolean(openCode.status?.installed);

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

      <div className="wizard-stage">
        <WizardScene key={stepId} showBack={stepIndex > 0} onBack={goBack}>
          {stepId === "welcome" && (
            <div className="wizard-layout wizard-welcome">
              <div className="wizard-copy">
                <div className="wizard-eyebrow">First run</div>
                <h1 className="wizard-title">
                  Your <span>Falck</span> story starts now.
                </h1>
                <p className="wizard-subtitle">
                  We will guide you through a cinematic first run so your workspace
                  feels ready, powerful, and unmistakably yours.
                </p>
                <div className="wizard-cta-row">
                  <Button
                    size="lg"
                    className="wizard-cta"
                    onClick={handleAdvance}
                  >
                    Begin the journey
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                  <div className="wizard-caption">About 5 minutes</div>
                </div>
              </div>
              <div className="wizard-portal">
                <div className="wizard-portal-ring ring-one" />
                <div className="wizard-portal-ring ring-two" />
                <div className="wizard-portal-core">
                  <img src={logo} alt="Falck" className="wizard-portal-logo" />
                </div>
                <div className="wizard-portal-orbit" />
                <div className="wizard-portal-spark" />
              </div>
            </div>
          )}

          {stepId === "github" && (
            <div className="wizard-layout wizard-github">
              <div className="wizard-copy">
                <div className="wizard-eyebrow">Secure handshake</div>
                <h1 className="wizard-title">
                  Connect <span>GitHub</span>
                </h1>
                <p className="wizard-subtitle">
                  Falck uses GitHub to find your repositories, create projects, and
                  sync changes. We use a secure device flow so passwords never touch
                  the app.
                </p>
                <div className="wizard-action-stack">
                  <Button
                    size="lg"
                    className="wizard-cta"
                    onClick={() => void github.connect()}
                    disabled={github.working || github.checking || github.connected}
                  >
                    {github.connected
                      ? "Connected"
                      : github.working
                        ? "Connecting..."
                        : "Connect GitHub"}
                  </Button>
                  {github.connected && (
                    <Button
                      variant="outline"
                      onClick={handleAdvance}
                    >
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
                </div>
                {github.error && (
                  <Alert variant="destructive">
                    <AlertDescription>{github.error}</AlertDescription>
                  </Alert>
                )}
              </div>
              <div className="wizard-device">
                <div className="wizard-device-card">
                  <div className="wizard-device-label">Device code</div>
                  <div className="wizard-device-code">
                    {github.device?.user_code ?? (github.connected ? "READY" : "FALCK")}
                  </div>
                  <div className="wizard-device-text">
                    {github.device
                      ? `Open ${github.device.verification_uri} and enter the code.`
                      : "We will open a secure browser flow for you."}
                  </div>
                  {github.connected && (
                    <div className="wizard-device-confirm">
                      <Check className="h-4 w-4" />
                      Authentication complete
                    </div>
                  )}
                </div>
                <div className="wizard-device-beam" />
              </div>
            </div>
          )}

          {stepId === "ssh" && (
            <div className="wizard-grid-two">
              <div className="wizard-stack">
                <WizardPanel
                  title="Choose a key"
                  description="Pick an existing SSH key from your machine."
                  icon={<KeyRound className="h-4 w-4" />}
                >
                  {ssh.loading ? (
                    <div className="wizard-placeholder">Loading SSH keys...</div>
                  ) : ssh.keys.length === 0 ? (
                    <div className="wizard-placeholder">No SSH keys found yet.</div>
                  ) : (
                    <div className="wizard-choice-list">
                      {ssh.keys.map((key) => (
                        <button
                          key={key.fingerprint}
                          className={cn(
                            "wizard-choice",
                            ssh.selectedKey?.fingerprint === key.fingerprint &&
                              "is-selected",
                          )}
                          onClick={() => ssh.selectKey(key)}
                        >
                          <div>
                            <div className="wizard-choice-title">{key.name}</div>
                            <div className="wizard-choice-meta">{key.fingerprint}</div>
                          </div>
                          <div className="wizard-choice-tag">
                            {key.public_key.includes("ssh-ed25519") ? "Ed25519" : "RSA"}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="wizard-inline-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void ssh.refreshKeys()}
                    >
                      Refresh keys
                    </Button>
                  </div>
                  {ssh.error && (
                    <Alert variant="destructive">
                      <AlertDescription>{ssh.error}</AlertDescription>
                    </Alert>
                  )}
                </WizardPanel>

                <WizardPanel
                  title="Forge a new key"
                  description="Generate a secure key directly inside Falck."
                  icon={<Sparkles className="h-4 w-4" />}
                >
                  <div className="wizard-form">
                    <div className="wizard-field">
                      <Label htmlFor="wizard-key-name">Key name</Label>
                      <Input
                        id="wizard-key-name"
                        value={newKeyName}
                        onChange={(event) => setNewKeyName(event.target.value)}
                        placeholder="falck"
                      />
                    </div>
                    <div className="wizard-field">
                      <Label>Key type</Label>
                      <Select
                        value={newKeyType}
                        onValueChange={(value) => setNewKeyType(value as KeyType)}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select key type" />
                        </SelectTrigger>
                        <SelectContent>
                          {Object.entries(KEY_TYPE_LABELS).map(([value, label]) => (
                            <SelectItem key={value} value={value}>
                              {label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="wizard-field">
                      <Label htmlFor="wizard-key-pass">Passphrase (optional)</Label>
                      <Input
                        id="wizard-key-pass"
                        type="password"
                        value={newKeyPassphrase}
                        onChange={(event) => setNewKeyPassphrase(event.target.value)}
                      />
                    </div>
                    <div className="wizard-field">
                      <Label htmlFor="wizard-key-confirm">Confirm passphrase</Label>
                      <Input
                        id="wizard-key-confirm"
                        type="password"
                        value={newKeyConfirm}
                        onChange={(event) => setNewKeyConfirm(event.target.value)}
                      />
                    </div>
                  </div>
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
                    {ssh.creatingKey ? "Forging..." : "Generate key"}
                  </Button>
                  {ssh.createError && (
                    <Alert variant="destructive">
                      <AlertDescription>{ssh.createError}</AlertDescription>
                    </Alert>
                  )}
                </WizardPanel>
              </div>

              <div className="wizard-stack">
                <WizardPanel
                  title="Bind to GitHub"
                  description="Add your key to GitHub so Falck can authenticate Git operations."
                  icon={<Github className="h-4 w-4" />}
                >
                  {ssh.selectedKey ? (
                    <div className="wizard-bind">
                      <div>
                        <div className="wizard-choice-title">{ssh.selectedKey.name}</div>
                        <div className="wizard-choice-meta">{ssh.selectedKey.fingerprint}</div>
                      </div>
                      <Button
                        className="wizard-cta"
                        onClick={() => void ssh.addKeyToGithub()}
                        disabled={ssh.addingKey || ssh.keyAdded || !github.connected}
                      >
                        {ssh.keyAdded
                          ? "Key added"
                          : ssh.addingKey
                            ? "Uploading..."
                            : github.connected
                              ? "Add key to GitHub"
                              : "Connect GitHub first"}
                      </Button>
                    </div>
                  ) : (
                    <div className="wizard-placeholder">Select or generate a key.</div>
                  )}
                  <WizardToggle
                    checked={ssh.manualConfirmed}
                    onChange={(value) => ssh.setManualConfirmed(value)}
                    label="I added the key manually"
                    description="Use this if you pasted the key in GitHub settings yourself."
                  />
                </WizardPanel>

                <WizardPanel
                  title="Manual ritual"
                  description="Copy the key and paste it in GitHub if you prefer manual setup."
                  icon={<KeyRound className="h-4 w-4" />}
                >
                  {ssh.selectedKey ? (
                    <div className="wizard-manual">
                      <div className="wizard-manual-key">
                        <div className="wizard-device-label">Public key</div>
                        <code>{ssh.selectedKey.public_key}</code>
                        <Button variant="outline" size="sm" onClick={() => ssh.copyKey()}>
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
                        <Label htmlFor="wizard-agent-pass">Add to SSH agent</Label>
                        <div className="wizard-agent-row">
                          <Input
                            id="wizard-agent-pass"
                            type="password"
                            placeholder="Optional passphrase"
                            value={agentPassphrase}
                            onChange={(event) => setAgentPassphrase(event.target.value)}
                          />
                          <Button
                            variant="outline"
                            onClick={() => void ssh.addToAgent(agentPassphrase)}
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
                  ) : (
                    <div className="wizard-placeholder">Select a key to reveal the ritual.</div>
                  )}
                </WizardPanel>

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
                      Add your SSH key to GitHub to continue.
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {stepId === "backend" && (
            <div className="wizard-layout wizard-backend">
              <div className="wizard-copy">
                <div className="wizard-eyebrow">Where it runs</div>
                <h1 className="wizard-title">
                  Choose your <span>workspace</span>
                </h1>
                <p className="wizard-subtitle">
                  Pick the default engine Falck uses for projects. Virtual mode is
                  recommended when supported on your machine.
                </p>
                {backend.error && (
                  <Alert variant="destructive">
                    <AlertDescription>{backend.error}</AlertDescription>
                  </Alert>
                )}
                {backend.loading && (
                  <div className="wizard-caption">Checking prerequisites...</div>
                )}
              </div>
              <div className="wizard-backend-grid">
                {(["virtualized", "host"] as BackendMode[]).map((mode) => {
                  const isVirtualized = mode === "virtualized";
                  const disabled = isVirtualized && !backend.prereq?.installed;
                  return (
                    <button
                      key={mode}
                      className={cn(
                        "wizard-mode",
                        backend.mode === mode && "is-selected",
                        disabled && "is-disabled",
                      )}
                      onClick={() =>
                        disabled ? null : void backend.selectMode(mode)
                      }
                    >
                      <div className="wizard-mode-icon">
                        {isVirtualized ? (
                          <Cloud className="h-5 w-5" />
                        ) : (
                          <Cpu className="h-5 w-5" />
                        )}
                      </div>
                      <div>
                        <div className="wizard-mode-title">
                          {MODE_COPY[mode].title}
                        </div>
                        <div className="wizard-mode-desc">
                          {MODE_COPY[mode].description}
                        </div>
                      </div>
                      <div className="wizard-mode-tag">
                        {isVirtualized && backend.prereq?.installed
                          ? "Recommended"
                          : disabled
                            ? `Needs ${backend.prereq?.tool ?? "setup"}`
                            : ""}
                      </div>
                    </button>
                  );
                })}
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
              </div>
            </div>
          )}

          {stepId === "opencode" && (
            <div className="wizard-layout wizard-opencode">
              <div className="wizard-copy">
                <div className="wizard-eyebrow">OpenCode engine</div>
                <h1 className="wizard-title">
                  Activate <span>OpenCode</span>
                </h1>
                <p className="wizard-subtitle">
                  OpenCode powers Falck's AI features locally. Install it once, then
                  connect your preferred AI providers.
                </p>
                <WizardPanel
                  title="Install OpenCode"
                  description="Install the CLI runtime that Falck uses for AI requests."
                  icon={<Terminal className="h-4 w-4" />}
                >
                  <div className="wizard-status-line">
                    {openCode.status?.installed ? (
                      <>
                        <Check className="h-4 w-4" />
                        OpenCode installed
                      </>
                    ) : (
                      <span>OpenCode not installed yet</span>
                    )}
                  </div>
                  <div className="wizard-inline-actions">
                    <Button
                      onClick={() => void openCode.install()}
                      disabled={openCode.installing}
                      className="wizard-cta"
                    >
                      {openCode.installing ? "Installing..." : "Install OpenCode"}
                    </Button>
                    <Button variant="outline" onClick={() => void openCode.refreshStatus()}>
                      Check again
                    </Button>
                  </div>
                  {openCode.message && (
                    <div className="wizard-caption">{openCode.message}</div>
                  )}
                  {openCode.manual && (
                    <div className="wizard-caption">
                      Manual install opened in your browser. Finish it and check again.
                    </div>
                  )}
                  {openCode.error && (
                    <Alert variant="destructive">
                      <AlertDescription>{openCode.error}</AlertDescription>
                    </Alert>
                  )}
                </WizardPanel>

                <WizardToggle
                  checked={skipOpenCode}
                  onChange={(value) => setSkipOpenCode(value)}
                  label="Skip OpenCode for now"
                  description="You can enable it later from Settings."
                />

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
                    <div className="wizard-caption">
                      Install OpenCode or choose to skip.
                    </div>
                  )}
                </div>
              </div>

              <div className="wizard-opencode-side">
                <div className="wizard-signal">
                  <div className="wizard-signal-core" />
                  <div className="wizard-signal-ring ring-one" />
                  <div className="wizard-signal-ring ring-two" />
                </div>
                <WizardPanel
                  title="Connect providers"
                  description="Add at least one AI provider so OpenCode can respond."
                  icon={<Sparkles className="h-4 w-4" />}
                >
                  <div className="wizard-provider-grid">
                    {openCode.providerLoading ? (
                      <div className="wizard-caption">Loading providers...</div>
                    ) : openCode.connectedProviders.length > 0 ? (
                      openCode.connectedProviders.map((provider) => (
                        <span key={provider} className="wizard-provider-chip">
                          {provider}
                        </span>
                      ))
                    ) : (
                      <div className="wizard-caption">No providers connected yet.</div>
                    )}
                  </div>
                  {openCode.providerError && (
                    <Alert variant="destructive">
                      <AlertDescription>{openCode.providerError}</AlertDescription>
                    </Alert>
                  )}
                  <Button
                    variant="outline"
                    onClick={() => setOpenCodeSettingsOpen(true)}
                  >
                    Choose providers
                  </Button>
                </WizardPanel>
              </div>
            </div>
          )}

          {stepId === "finish" && (
            <div className="wizard-layout wizard-finish">
              <div className="wizard-copy">
                <div className="wizard-eyebrow">All set</div>
                <h1 className="wizard-title">
                  Your workspace is <span>ready</span>.
                </h1>
                <p className="wizard-subtitle">
                  Falck has your essentials configured. You are ready to build, ship,
                  and explore.
                </p>
                <Button size="lg" className="wizard-cta" onClick={handleAdvance}>
                  Enter Falck
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </div>
              <div className="wizard-summary">
                <WizardStat
                  title="GitHub"
                  value={github.connected ? github.user?.login ?? "Connected" : "Not connected"}
                  icon={<Github className="h-4 w-4" />}
                />
                <WizardStat
                  title="SSH key"
                  value={ssh.selectedKey?.name ?? "Not set"}
                  icon={<KeyRound className="h-4 w-4" />}
                />
                <WizardStat
                  title="Workspace"
                  value={backend.mode ? MODE_COPY[backend.mode].title : "Not set"}
                  icon={backend.mode === "virtualized" ? <Cloud className="h-4 w-4" /> : <Cpu className="h-4 w-4" />}
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
            </div>
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
      <div className="wizard-stars" />
      <div className="wizard-haze" />
      <div className="wizard-comet" />
      <div className="wizard-curtain" />
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

function WizardPanel({ title, description, icon, children, className }: WizardPanelProps) {
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

function WizardToggle({ checked, onChange, label, description }: WizardToggleProps) {
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
        {description && <span className="wizard-toggle-desc">{description}</span>}
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
