import { useEffect, useMemo, useState } from "react";
import { useForm } from "@tanstack/react-form";

import { FormField } from "@/components/form/FormField";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ModelSelectorLogo } from "@/components/ai-elements/model-selector";
import { setAPIKeySchema } from "@/schemas/forms";
import { Provider, opencodeService } from "@/services/opencodeService";
import { ArrowLeft } from "lucide-react";

interface OpenCodeSettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface OpenCodeSettingsContentProps {
  active: boolean;
}

type ProviderEntry = {
  id: string;
  name: string;
  note?: string;
  modelCount: number;
  provider: Provider;
};

const POPULAR_PROVIDERS = [
  "opencode",
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "github-copilot",
  "vercel",
];

const PROVIDER_NOTES: Record<string, string> = {
  opencode: "Curated models including Claude, GPT, Gemini and more.",
  anthropic: "Direct access to Claude models, including Pro and Max.",
  openai: "GPT models for fast, capable general AI tasks.",
  "github-copilot": "Claude models tuned for coding assistance.",
  google: "Gemini models for fast, structured responses.",
  openrouter: "Access all supported models from one provider.",
  vercel: "Unified access to AI models with smart routing.",
};

const providerIdFromModels = (provider: Provider) => {
  const model = provider.models.find((entry) => entry.includes("/"));
  if (model) {
    return model.split("/")[0];
  }
  return provider.name.toLowerCase().replace(/\s+/g, "-");
};

const getProviderLabel = (providers: Provider[], providerId: string) => {
  const match = providers.find(
    (provider) =>
      providerIdFromModels(provider) === providerId ||
      provider.name.toLowerCase() === providerId.toLowerCase(),
  );
  return match?.name ?? providerId;
};

const useOpenCodeSettings = (active: boolean) => {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loadingProviders, setLoadingProviders] = useState(true);
  const [saving, setSaving] = useState(false);

  const form = useForm({
    defaultValues: {
      provider: "",
      apiKey: "",
    },
    validators: {
      onSubmit: setAPIKeySchema,
    },
    onSubmit: async ({ value }) => {
      setSaving(true);
      setError(null);
      try {
        await opencodeService.setAuth(value.provider, value.apiKey);
        const label = getProviderLabel(providers, value.provider);
        setSuccess(`Authentication set for ${label}`);
        form.reset({ provider: value.provider, apiKey: "" });
        setTimeout(() => setSuccess(null), 3000);
      } catch (err) {
        setError(`Failed to set authentication: ${String(err)}`);
      } finally {
        setSaving(false);
      }
    },
  });

  useEffect(() => {
    if (!active) {
      return;
    }
    void loadProviders();
  }, [active]);

  const loadProviders = async () => {
    setLoadingProviders(true);
    try {
      const config = await opencodeService.getProviders();
      setProviders(config.providers);
      form.reset({ provider: "", apiKey: "" });
      setError(null);
    } catch (err) {
      setError(`Failed to load providers: ${String(err)}`);
    } finally {
      setLoadingProviders(false);
    }
  };

  return {
    providers,
    error,
    success,
    loadingProviders,
    saving,
    form,
  };
};

const OpenCodeSettingsContent = ({ active }: OpenCodeSettingsContentProps) => {
  const { providers, error, success, loadingProviders, saving, form } =
    useOpenCodeSettings(active);
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectView, setConnectView] = useState<"list" | "connect">("list");
  const [selectedProvider, setSelectedProvider] = useState<ProviderEntry | null>(
    null,
  );

  const providerEntries = useMemo<ProviderEntry[]>(
    () =>
      providers.map((provider) => {
        const id = providerIdFromModels(provider);
        return {
          id,
          name: provider.name || id,
          note: PROVIDER_NOTES[id],
          modelCount: provider.models.length,
          provider,
        };
      }),
    [providers],
  );

  const { popularProviders, otherProviders } = useMemo(() => {
    const popular: ProviderEntry[] = [];
    const other: ProviderEntry[] = [];
    for (const entry of providerEntries) {
      if (POPULAR_PROVIDERS.includes(entry.id)) {
        popular.push(entry);
      } else {
        other.push(entry);
      }
    }
    popular.sort(
      (a, b) =>
        POPULAR_PROVIDERS.indexOf(a.id) -
        POPULAR_PROVIDERS.indexOf(b.id),
    );
    other.sort((a, b) => a.name.localeCompare(b.name));
    return { popularProviders: popular, otherProviders: other };
  }, [providerEntries]);

  useEffect(() => {
    if (!connectOpen) {
      setConnectView("list");
    }
  }, [connectOpen]);

  useEffect(() => {
    if (success) {
      setConnectOpen(false);
      setConnectView("list");
    }
  }, [success]);

  useEffect(() => {
    if (!selectedProvider) {
      return;
    }
    const stillAvailable = providers.some(
      (provider) =>
        providerIdFromModels(provider) === selectedProvider.id,
    );
    if (!stillAvailable) {
      setSelectedProvider(null);
    }
  }, [providers, selectedProvider]);

  const handleSelectProvider = (entry: ProviderEntry) => {
    setSelectedProvider(entry);
    form.setFieldValue("provider", entry.id);
    form.setFieldValue("apiKey", "");
    setConnectView("connect");
  };

  const handleDialogOpenChange = (nextOpen: boolean) => {
    setConnectOpen(nextOpen);
    if (!nextOpen) {
      setConnectView("list");
      if (!success) {
        setSelectedProvider(null);
        form.setFieldValue("provider", "");
      }
    }
  };

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">Providers</h3>
            <p className="text-xs text-muted-foreground">
              Connect API keys to unlock OpenCode models inside Falck.
            </p>
          </div>
          <Button
            type="button"
            variant="secondary"
            className="normal-case tracking-normal"
            onClick={() => setConnectOpen(true)}
            disabled={loadingProviders || providers.length === 0}
          >
            {loadingProviders ? "Loading providers…" : "Connect provider"}
          </Button>
        </div>
        {selectedProvider && (
          <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-secondary/20 px-3 py-2 text-sm">
            <ModelSelectorLogo
              provider={selectedProvider.id}
              className="size-4"
            />
            <div className="flex-1">
              <div className="font-semibold text-foreground">
                {selectedProvider.name}
              </div>
              <div className="text-xs text-muted-foreground">
                Selected provider
              </div>
            </div>
            <Badge variant="secondary">Selected</Badge>
          </div>
        )}
      </section>

      <Dialog open={connectOpen} onOpenChange={handleDialogOpenChange}>
        <DialogContent className="max-w-2xl p-0">
          {connectView === "list" ? (
            <>
              <DialogHeader className="px-6 pt-6">
                <DialogTitle>Connect a provider</DialogTitle>
                <DialogDescription>
                  Search and choose a provider to add an API key.
                </DialogDescription>
              </DialogHeader>
              <Command className="border-none">
                <CommandInput
                  placeholder="Search providers..."
                  autoFocus
                />
                <CommandList className="max-h-[420px] px-2 pb-4">
                  <CommandEmpty>
                    {loadingProviders
                      ? "Loading providers..."
                      : "No providers found."}
                  </CommandEmpty>
                  {popularProviders.length > 0 && (
                    <CommandGroup heading="Popular">
                      {popularProviders.map((entry) => (
                        <CommandItem
                          key={entry.id}
                          value={`${entry.name} ${entry.id}`}
                          onSelect={() => handleSelectProvider(entry)}
                          className="items-start gap-3 rounded-lg px-3 py-3"
                        >
                          <ModelSelectorLogo
                            provider={entry.id}
                            className="mt-0.5 size-4"
                          />
                          <div className="flex flex-1 flex-col gap-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-semibold text-foreground">
                                {entry.name}
                              </span>
                              {entry.id === "opencode" && (
                                <Badge
                                  variant="secondary"
                                  className="text-[0.6rem]"
                                >
                                  Recommended
                                </Badge>
                              )}
                            </div>
                            {entry.note && (
                              <span className="text-xs text-muted-foreground">
                                {entry.note}
                              </span>
                            )}
                          </div>
                          <Badge
                            variant="outline"
                            className="ml-auto text-[0.6rem]"
                          >
                            {entry.modelCount} models
                          </Badge>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}
                  {popularProviders.length > 0 &&
                    otherProviders.length > 0 && <CommandSeparator />}
                  {otherProviders.length > 0 && (
                    <CommandGroup heading="Other">
                      {otherProviders.map((entry) => (
                        <CommandItem
                          key={entry.id}
                          value={`${entry.name} ${entry.id}`}
                          onSelect={() => handleSelectProvider(entry)}
                          className="items-start gap-3 rounded-lg px-3 py-3"
                        >
                          <ModelSelectorLogo
                            provider={entry.id}
                            className="mt-0.5 size-4"
                          />
                          <div className="flex flex-1 flex-col gap-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-semibold text-foreground">
                                {entry.name}
                              </span>
                            </div>
                            {entry.note && (
                              <span className="text-xs text-muted-foreground">
                                {entry.note}
                              </span>
                            )}
                          </div>
                          <Badge
                            variant="outline"
                            className="ml-auto text-[0.6rem]"
                          >
                            {entry.modelCount} models
                          </Badge>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}
                </CommandList>
              </Command>
            </>
          ) : (
            <div className="space-y-6 px-6 pb-6 pt-6">
              <div className="flex items-start gap-3">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    setConnectView("list");
                    setSelectedProvider(null);
                  }}
                  className="mt-0.5"
                >
                  <ArrowLeft className="h-4 w-4" />
                </Button>
                <div className="flex items-start gap-3">
                  <div className="flex size-9 items-center justify-center rounded-full bg-secondary/60">
                    {selectedProvider && (
                      <ModelSelectorLogo
                        provider={selectedProvider.id}
                        className="size-4"
                      />
                    )}
                  </div>
                  <div className="space-y-1">
                    <DialogTitle>
                      Connect {selectedProvider?.name ?? "provider"}
                    </DialogTitle>
                    <DialogDescription>
                      Enter your API key to enable{" "}
                      {selectedProvider?.name ?? "provider"} models.
                    </DialogDescription>
                  </div>
                </div>
              </div>
              {selectedProvider?.note && (
                <div className="rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  {selectedProvider.note}
                </div>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void form.handleSubmit();
                }}
                className="space-y-4"
              >
                <form.Field name="apiKey">
                  {(field) => (
                    <FormField
                      field={field}
                      label={`${selectedProvider?.name ?? "Provider"} API key`}
                      placeholder="Enter API key"
                      type="password"
                      required
                    />
                  )}
                </form.Field>
                <Button
                  type="submit"
                  disabled={saving}
                  className="w-full normal-case tracking-normal"
                >
                  {saving ? "Saving…" : "Save key"}
                </Button>
              </form>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Available models</h3>
        <div className="grid gap-3">
          {loadingProviders ? (
            <div className="rounded-lg border border-dashed border-border/70 bg-secondary/10 px-4 py-6 text-sm text-muted-foreground">
              Loading providers...
            </div>
          ) : providers.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/70 bg-secondary/10 px-4 py-6 text-sm text-muted-foreground">
              No providers available yet. Install or configure OpenCode to add
              providers.
            </div>
          ) : (
            providers.map((provider) => (
              <div
                key={providerIdFromModels(provider)}
                className="rounded-lg border-2 border-border bg-secondary/20 p-3 shadow-[var(--shadow-xs)]"
              >
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <ModelSelectorLogo
                    provider={providerIdFromModels(provider)}
                    className="size-4"
                  />
                  {provider.name}
                </div>
                <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                  {provider.models.map((model) => (
                    <li key={model}>{model}</li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>
      </section>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {success && (
        <Alert>
          <AlertDescription>{success}</AlertDescription>
        </Alert>
      )}
    </div>
  );
};

interface OpenCodeSettingsPanelProps {
  className?: string;
}

export function OpenCodeSettingsPanel({ className }: OpenCodeSettingsPanelProps) {
  return (
    <Card className={className}>
      <CardHeader className="border-b border-border/60 pb-5">
        <CardTitle>OpenCode settings</CardTitle>
        <CardDescription>Configure API keys and view models.</CardDescription>
      </CardHeader>
      <CardContent className="pt-6">
        <OpenCodeSettingsContent active />
      </CardContent>
    </Card>
  );
}

export function OpenCodeSettings({ open, onOpenChange }: OpenCodeSettingsProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>OpenCode settings</DialogTitle>
          <DialogDescription>Configure API keys and view models.</DialogDescription>
        </DialogHeader>

        <OpenCodeSettingsContent active={open} />
      </DialogContent>
    </Dialog>
  );
}
