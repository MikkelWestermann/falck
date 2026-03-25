import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
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
import {
  OpenCodeConfigData,
  OpenCodeImageSettings,
  OpenCodeImageProvider,
  opencodeService,
} from "@/services/opencodeService";

interface OpenCodeImageSettingsSectionProps {
  active: boolean;
  config: OpenCodeConfigData | null;
  onError: (message: string | null) => void;
  onSuccess: (message: string) => void;
}

type ImageSettingsForm = {
  defaultProvider: "auto" | OpenCodeImageProvider;
  openaiApiKey: string;
  azureEndpoint: string;
  azureDeploymentName: string;
  azureApiKey: string;
};

const DEFAULT_FORM: ImageSettingsForm = {
  defaultProvider: "auto",
  openaiApiKey: "",
  azureEndpoint: "",
  azureDeploymentName: "",
  azureApiKey: "",
};

const normalizeResourceName = (value: unknown) => {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "";
};

const endpointFromResourceName = (resourceName: string) =>
  resourceName ? `https://${resourceName}.openai.azure.com` : "";

const hasKeyStatus = (
  hasStoredApiKey: boolean,
  hasEnvApiKey: boolean,
  hasOpencodeApiKey: boolean,
) => hasStoredApiKey || hasEnvApiKey || hasOpencodeApiKey;

const toPlacementToolPath = (toolPath: string | null | undefined) => {
  if (!toolPath) {
    return "";
  }
  return toolPath.replace(/falck_generate_image\.ts$/, "falck_place_image.ts");
};

export function OpenCodeImageSettingsSection({
  active,
  config,
  onError,
  onSuccess,
}: OpenCodeImageSettingsSectionProps) {
  const [settings, setSettings] = useState<OpenCodeImageSettings | null>(null);
  const [form, setForm] = useState<ImageSettingsForm>(DEFAULT_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const azureResourceName = useMemo(() => {
    const providerConfig = config?.provider?.azure;
    if (
      !providerConfig?.options ||
      typeof providerConfig.options !== "object"
    ) {
      return "";
    }
    return normalizeResourceName(
      (providerConfig.options as Record<string, unknown>).resourceName,
    );
  }, [config?.provider?.azure]);

  const applySettings = (next: OpenCodeImageSettings) => {
    setSettings(next);
    setForm({
      defaultProvider: next.defaultProvider ?? "auto",
      openaiApiKey: "",
      azureEndpoint: next.azure.overrideEndpoint,
      azureDeploymentName: next.azure.overrideDeploymentName,
      azureApiKey: "",
    });
  };

  const loadSettings = async () => {
    setLoading(true);
    try {
      const next = await opencodeService.getImageGenerationSettings();
      applySettings(next);
      onError(null);
    } catch (err) {
      onError(`Failed to load image generation settings: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!active) {
      return;
    }
    void loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const next = await opencodeService.saveImageGenerationSettings({
        defaultProvider:
          form.defaultProvider === "auto" ? null : form.defaultProvider,
        openaiApiKey: form.openaiApiKey || undefined,
        azureApiKey: form.azureApiKey || undefined,
        azureEndpoint: form.azureEndpoint,
        azureDeploymentName: form.azureDeploymentName,
      });
      applySettings(next);
      onError(null);
      onSuccess("Saved image generation settings.");
    } catch (err) {
      onError(`Failed to save image generation settings: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const forgetKey = async (provider: OpenCodeImageProvider) => {
    setSaving(true);
    try {
      const next = await opencodeService.saveImageGenerationSettings({
        defaultProvider:
          form.defaultProvider === "auto" ? null : form.defaultProvider,
        azureEndpoint: form.azureEndpoint,
        azureDeploymentName: form.azureDeploymentName,
        clearOpenaiApiKey: provider === "openai",
        clearAzureApiKey: provider === "azure",
      });
      applySettings(next);
      onError(null);
      onSuccess(
        provider === "openai"
          ? "Removed the stored OpenAI image key."
          : "Removed the stored Azure image key.",
      );
    } catch (err) {
      onError(`Failed to update image keys: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const openaiReady = hasKeyStatus(
    settings?.openai.hasStoredApiKey ?? false,
    settings?.openai.hasEnvApiKey ?? false,
    settings?.openai.hasOpencodeApiKey ?? false,
  );
  const resolvedAzureEndpoint =
    settings?.azure.resolvedEndpoint ||
    endpointFromResourceName(azureResourceName);
  const resolvedAzureDeploymentName =
    settings?.azure.resolvedDeploymentName ?? "";
  const placementTool = toPlacementToolPath(settings?.toolPath);
  const azureConfigDetected =
    Boolean(azureResourceName) ||
    Boolean(settings?.azure.hasOpencodeEndpoint) ||
    Boolean(settings?.azure.hasOpencodeDeploymentName);
  const azureReady =
    hasKeyStatus(
      settings?.azure.hasStoredApiKey ?? false,
      settings?.azure.hasEnvApiKey ?? false,
      settings?.azure.hasOpencodeApiKey ?? false,
    ) &&
    Boolean(resolvedAzureEndpoint.trim()) &&
    Boolean(resolvedAzureDeploymentName.trim());

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">Image generation</h3>
          {settings?.toolInstalled && (
            <Badge variant="secondary" className="text-[0.6rem]">
              Tools installed
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Install Falck-managed OpenCode image tools backed by GPT Image 1.5.
          Falck reuses your existing OpenCode auth and config by default. Values
          entered here are image-generation-specific overrides. The generator
          can save directly to a repo path, and it also includes a placement
          tool for moving temp images into the repo without Bash.
        </p>
      </div>

      <div className="rounded-lg border border-border/60 bg-secondary/10 p-4 text-xs text-muted-foreground">
        <div>
          Global OpenCode directory:{" "}
          <span className="font-mono text-foreground">
            {settings?.globalDir || "Loading..."}
          </span>
        </div>
        <div className="mt-1">
          Generator tool path:{" "}
          <span className="font-mono text-foreground">
            {settings?.toolPath || "Loading..."}
          </span>
        </div>
        <div className="mt-1">
          Placement tool path:{" "}
          <span className="font-mono text-foreground">
            {placementTool || "Loading..."}
          </span>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2 rounded-lg border border-border/60 bg-card/70 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold text-foreground">OpenAI</h4>
            {openaiReady ? (
              <Badge variant="secondary" className="text-[0.6rem]">
                Ready
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[0.6rem]">
                Not configured
              </Badge>
            )}
            {settings?.openai.hasStoredApiKey && (
              <Badge variant="outline" className="text-[0.6rem]">
                Stored key
              </Badge>
            )}
            {settings?.openai.hasEnvApiKey && (
              <Badge variant="outline" className="text-[0.6rem]">
                Env key
              </Badge>
            )}
            {settings?.openai.hasOpencodeApiKey && (
              <Badge variant="outline" className="text-[0.6rem]">
                OpenCode auth
              </Badge>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="falck-image-openai-key">
              OpenAI API key override
            </Label>
            <Input
              id="falck-image-openai-key"
              type="password"
              value={form.openaiApiKey}
              onChange={(event) =>
                setForm((prev) => ({
                  ...prev,
                  openaiApiKey: event.target.value,
                }))
              }
              placeholder={
                settings?.openai.hasStoredApiKey
                  ? "Leave blank to keep the stored override"
                  : openaiReady
                    ? "Leave blank to reuse OpenCode or env auth"
                    : "sk-..."
              }
              disabled={loading || saving}
            />
            <p className="text-xs text-muted-foreground">
              Leave this blank unless you want Falck to use a different OpenAI
              key than OpenCode.
            </p>
          </div>
          <div className="flex gap-2">
            {settings?.openai.hasStoredApiKey && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void forgetKey("openai")}
                disabled={saving}
              >
                Forget key
              </Button>
            )}
          </div>
        </div>

        <div className="space-y-2 rounded-lg border border-border/60 bg-card/70 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold text-foreground">Azure</h4>
            {azureReady ? (
              <Badge variant="secondary" className="text-[0.6rem]">
                Ready
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[0.6rem]">
                Not configured
              </Badge>
            )}
            {settings?.azure.hasStoredApiKey && (
              <Badge variant="outline" className="text-[0.6rem]">
                Stored key
              </Badge>
            )}
            {settings?.azure.hasEnvApiKey && (
              <Badge variant="outline" className="text-[0.6rem]">
                Env key
              </Badge>
            )}
            {settings?.azure.hasOpencodeApiKey && (
              <Badge variant="outline" className="text-[0.6rem]">
                OpenCode auth
              </Badge>
            )}
            {azureConfigDetected && (
              <Badge variant="outline" className="text-[0.6rem]">
                OpenCode config
              </Badge>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="falck-image-azure-endpoint">
              Azure endpoint override
            </Label>
            <Input
              id="falck-image-azure-endpoint"
              value={form.azureEndpoint}
              onChange={(event) =>
                setForm((prev) => ({
                  ...prev,
                  azureEndpoint: event.target.value,
                }))
              }
              placeholder={
                resolvedAzureEndpoint
                  ? "Leave blank to reuse the detected endpoint"
                  : "https://your-resource.openai.azure.com"
              }
              disabled={loading || saving}
            />
            <p className="text-xs text-muted-foreground">
              {resolvedAzureEndpoint ? (
                <>
                  Detected endpoint:{" "}
                  <span className="font-mono text-foreground">
                    {resolvedAzureEndpoint}
                  </span>
                </>
              ) : (
                "Leave this blank unless you want a Falck-only Azure endpoint override."
              )}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="falck-image-azure-deployment">
              Azure deployment override
            </Label>
            <Input
              id="falck-image-azure-deployment"
              value={form.azureDeploymentName}
              onChange={(event) =>
                setForm((prev) => ({
                  ...prev,
                  azureDeploymentName: event.target.value,
                }))
              }
              placeholder={
                resolvedAzureDeploymentName
                  ? "Leave blank to reuse the detected image deployment"
                  : "gpt-image-1.5 deployment"
              }
              disabled={loading || saving}
            />
            <p className="text-xs text-muted-foreground">
              {resolvedAzureDeploymentName ? (
                <>
                  Detected image deployment:{" "}
                  <span className="font-mono text-foreground">
                    {resolvedAzureDeploymentName}
                  </span>
                </>
              ) : (
                "Azure image generation still needs a gpt-image-1.5 deployment if OpenCode has not already configured one."
              )}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="falck-image-azure-key">
              Azure API key override
            </Label>
            <Input
              id="falck-image-azure-key"
              type="password"
              value={form.azureApiKey}
              onChange={(event) =>
                setForm((prev) => ({
                  ...prev,
                  azureApiKey: event.target.value,
                }))
              }
              placeholder={
                settings?.azure.hasStoredApiKey
                  ? "Leave blank to keep the stored override"
                  : hasKeyStatus(
                        settings?.azure.hasStoredApiKey ?? false,
                        settings?.azure.hasEnvApiKey ?? false,
                        settings?.azure.hasOpencodeApiKey ?? false,
                      )
                    ? "Leave blank to reuse OpenCode or env auth"
                    : "Azure image API key"
              }
              disabled={loading || saving}
            />
            <p className="text-xs text-muted-foreground">
              Leave this blank unless you want Falck to use a different Azure
              key than OpenCode.
            </p>
          </div>
          <div className="flex gap-2">
            {settings?.azure.hasStoredApiKey && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void forgetKey("azure")}
                disabled={saving}
              >
                Forget key
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-3 rounded-lg border border-border/60 bg-card/70 p-4 md:grid-cols-[minmax(0,220px)_1fr] md:items-end">
        <div className="space-y-2">
          <Label htmlFor="falck-image-default-provider">Default provider</Label>
          <Select
            value={form.defaultProvider}
            onValueChange={(value) =>
              setForm((prev) => ({
                ...prev,
                defaultProvider: value as ImageSettingsForm["defaultProvider"],
              }))
            }
            disabled={loading || saving}
          >
            <SelectTrigger id="falck-image-default-provider">
              <SelectValue placeholder="Automatic" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Automatic</SelectItem>
              <SelectItem value="openai">OpenAI</SelectItem>
              <SelectItem value="azure">Azure</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex justify-start md:justify-end">
          <Button
            type="button"
            onClick={() => void handleSave()}
            disabled={loading || saving}
          >
            {saving ? "Saving..." : "Save image settings"}
          </Button>
        </div>
      </div>
    </section>
  );
}
