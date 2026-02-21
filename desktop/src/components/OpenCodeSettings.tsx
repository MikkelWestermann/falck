import { useEffect, useMemo, useState } from "react";

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ModelSelectorLogo } from "@/components/ai-elements/model-selector";
import {
  opencodeService,
  OpenCodeConfigData,
  OpenCodeProviderList,
  OpenCodeProviderListItem,
  Provider,
  ProviderAuthAuthorization,
  ProviderAuthMethod,
  ProviderAuthResponse,
} from "@/services/opencodeService";
import { falckService } from "@/services/falckService";
import { ArrowLeft } from "lucide-react";

interface OpenCodeSettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface OpenCodeSettingsContentProps {
  active: boolean;
}

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

const OPENAI_COMPATIBLE = "@ai-sdk/openai-compatible";

const defaultProviderList: OpenCodeProviderList = {
  all: [],
  default: {},
  connected: [],
};

const getProviderNote = (providerId: string) => PROVIDER_NOTES[providerId];

const providerIdFromModels = (provider: Provider) => {
  const model = provider.models.find((entry) => entry.includes("/"));
  if (model) {
    return model.split("/")[0];
  }
  return provider.name.toLowerCase().replace(/\s+/g, "-");
};

const isConfigCustom = (config: OpenCodeConfigData | null, providerId: string) => {
  const entry = config?.provider?.[providerId];
  if (!entry) return false;
  if (entry.npm !== OPENAI_COMPATIBLE) return false;
  if (!entry.models || Object.keys(entry.models).length === 0) return false;
  return true;
};

const providerTagLabel = (provider: OpenCodeProviderListItem, config: OpenCodeConfigData | null) => {
  const source = provider.source;
  if (source === "env") return "Environment";
  if (source === "api") return "API key";
  if (source === "config") {
    if (isConfigCustom(config, provider.id)) return "Custom";
    return "Config";
  }
  if (source === "custom") return "Custom";
  return "Other";
};

const canDisconnect = (provider: OpenCodeProviderListItem) => provider.source !== "env";

const useOpenCodeProviders = (active: boolean) => {
  const [providerList, setProviderList] = useState<OpenCodeProviderList>(
    defaultProviderList,
  );
  const [providerAuth, setProviderAuth] = useState<ProviderAuthResponse>({});
  const [config, setConfig] = useState<OpenCodeConfigData>({});
  const [modelProviders, setModelProviders] = useState<Provider[]>([]);
  const [loadingProviders, setLoadingProviders] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const loadProviders = async () => {
    setLoadingProviders(true);
    try {
      const [providerCatalog, authMethods, configResponse, modelConfig] =
        await Promise.all([
          opencodeService.listProviderCatalog(),
          opencodeService.getProviderAuth(),
          opencodeService.getConfig(),
          opencodeService.getProviders(),
        ]);
      setProviderList(providerCatalog ?? defaultProviderList);
      setProviderAuth(authMethods ?? {});
      setConfig(configResponse?.config ?? {});
      setModelProviders(modelConfig.providers ?? []);
      setError(null);
    } catch (err) {
      setError(`Failed to load providers: ${String(err)}`);
    } finally {
      setLoadingProviders(false);
    }
  };

  const showSuccess = (message: string) => {
    setSuccess(message);
    window.setTimeout(() => setSuccess(null), 3000);
  };

  useEffect(() => {
    if (!active) {
      return;
    }
    void loadProviders();
  }, [active]);

  return {
    providerList,
    providerAuth,
    config,
    modelProviders,
    loadingProviders,
    error,
    success,
    setError,
    showSuccess,
    loadProviders,
  };
};

type ProviderDialogView = "select" | "connect" | "custom";

interface ProviderSelectViewProps {
  loading: boolean;
  popularProviders: OpenCodeProviderListItem[];
  otherProviders: OpenCodeProviderListItem[];
  onSelectProvider: (providerId: string) => void;
  onSelectCustom: () => void;
}

function ProviderSelectView({
  loading,
  popularProviders,
  otherProviders,
  onSelectProvider,
  onSelectCustom,
}: ProviderSelectViewProps) {
  return (
    <>
      <DialogHeader className="flex-shrink-0 px-6 pt-6">
        <DialogTitle>Connect a provider</DialogTitle>
        <DialogDescription>
          Search and choose a provider to add an API key or OAuth connection.
        </DialogDescription>
      </DialogHeader>
      <Command className="border-none flex-1 min-h-0 flex flex-col overflow-hidden">
        <CommandInput placeholder="Search providers..." autoFocus />
        <CommandList className="min-h-0 flex-1 max-h-[50vh] overflow-y-auto px-2 pb-4">
          <CommandEmpty>
            {loading ? "Loading providers..." : "No providers found."}
          </CommandEmpty>
          {!loading && (
            <>
              <CommandGroup heading="Custom">
                <CommandItem
                  value="custom provider"
                  onSelect={onSelectCustom}
                  className="items-start gap-3 rounded-lg px-3 py-3"
                >
                  <ModelSelectorLogo provider="synthetic" className="mt-0.5 size-4" />
                  <div className="flex flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">
                        Custom provider
                      </span>
                      <Badge variant="secondary" className="text-[0.6rem]">
                        Custom
                      </Badge>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      Add an OpenAI-compatible provider by base URL.
                    </span>
                  </div>
                </CommandItem>
              </CommandGroup>

              {(popularProviders.length > 0 || otherProviders.length > 0) && (
                <CommandSeparator />
              )}

              {popularProviders.length > 0 && (
                <CommandGroup heading="Popular">
                  {popularProviders.map((entry) => (
                    <CommandItem
                      key={entry.id}
                      value={`${entry.name} ${entry.id}`}
                      onSelect={() => onSelectProvider(entry.id)}
                      className="items-start gap-3 rounded-lg px-3 py-3"
                    >
                      <ModelSelectorLogo provider={entry.id} className="mt-0.5 size-4" />
                      <div className="flex flex-1 flex-col gap-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold text-foreground">
                            {entry.name}
                          </span>
                          {entry.id === "opencode" && (
                            <Badge variant="secondary" className="text-[0.6rem]">
                              Recommended
                            </Badge>
                          )}
                        </div>
                        {getProviderNote(entry.id) && (
                          <span className="text-xs text-muted-foreground">
                            {getProviderNote(entry.id)}
                          </span>
                        )}
                      </div>
                      <Badge variant="outline" className="ml-auto text-[0.6rem]">
                        {entry.modelCount} models
                      </Badge>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}

              {popularProviders.length > 0 && otherProviders.length > 0 && <CommandSeparator />}

              {otherProviders.length > 0 && (
                <CommandGroup heading="Other">
                  {otherProviders.map((entry) => (
                    <CommandItem
                      key={entry.id}
                      value={`${entry.name} ${entry.id}`}
                      onSelect={() => onSelectProvider(entry.id)}
                      className="items-start gap-3 rounded-lg px-3 py-3"
                    >
                      <ModelSelectorLogo provider={entry.id} className="mt-0.5 size-4" />
                      <div className="flex flex-1 flex-col gap-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold text-foreground">
                            {entry.name}
                          </span>
                        </div>
                        {getProviderNote(entry.id) && (
                          <span className="text-xs text-muted-foreground">
                            {getProviderNote(entry.id)}
                          </span>
                        )}
                      </div>
                      <Badge variant="outline" className="ml-auto text-[0.6rem]">
                        {entry.modelCount} models
                      </Badge>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </>
          )}
        </CommandList>
      </Command>
    </>
  );
}

interface ProviderConnectViewProps {
  provider: OpenCodeProviderListItem;
  methods: ProviderAuthMethod[];
  onBack: () => void;
  onComplete: (provider: OpenCodeProviderListItem) => void;
}

function ProviderConnectView({
  provider,
  methods,
  onBack,
  onComplete,
}: ProviderConnectViewProps) {
  const resolvedMethods = methods.length
    ? methods
    : [{ type: "api", label: "API key" }];
  const [methodIndex, setMethodIndex] = useState<number | null>(null);
  const [authorization, setAuthorization] =
    useState<ProviderAuthAuthorization | null>(null);
  const [state, setState] = useState<"idle" | "pending" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [apiError, setApiError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const activeMethod =
    methodIndex !== null ? resolvedMethods[methodIndex] : null;

  useEffect(() => {
    if (resolvedMethods.length === 1 && methodIndex === null) {
      void selectMethod(0);
    }
  }, [resolvedMethods.length, methodIndex]);

  useEffect(() => {
    if (!authorization?.url) {
      return;
    }
    void falckService.openInBrowser(authorization.url).catch(() => undefined);
  }, [authorization?.url]);

  useEffect(() => {
    if (authorization?.method !== "auto") {
      return;
    }
    if (methodIndex === null) {
      return;
    }
    let active = true;
    setState("pending");
    setError(null);
    void (async () => {
      try {
        const result = await opencodeService.callbackProviderOAuth(
          provider.id,
          methodIndex,
        );
        if (!active) return;
        if (result.success) {
          await onComplete(provider);
          return;
        }
        setState("error");
        setError("OAuth confirmation failed.");
      } catch (err) {
        if (!active) return;
        setState("error");
        setError(String(err));
      }
    })();
    return () => {
      active = false;
    };
  }, [authorization?.method, methodIndex, onComplete, provider]);

  const selectMethod = async (index: number) => {
    setMethodIndex(index);
    setAuthorization(null);
    setError(null);
    setState("idle");
    const selected = resolvedMethods[index];
    if (selected.type !== "oauth") {
      return;
    }

    setState("pending");
    try {
      const auth = await opencodeService.authorizeProviderOAuth(
        provider.id,
        index,
      );
      setAuthorization(auth);
      setState("idle");
    } catch (err) {
      setError(String(err));
      setState("error");
    }
  };

  const handleApiSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!apiKey.trim()) {
      setApiError("API key is required.");
      return;
    }
    setApiError(null);
    setSubmitting(true);
    try {
      await opencodeService.setAuth(provider.id, apiKey.trim());
      await onComplete(provider);
    } catch (err) {
      setApiError(String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCodeSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!code.trim()) {
      setCodeError("Verification code is required.");
      return;
    }
    setCodeError(null);
    setSubmitting(true);
    try {
      const result = await opencodeService.callbackProviderOAuth(
        provider.id,
        methodIndex ?? 0,
        code.trim(),
      );
      if (!result.success) {
        setCodeError("Verification failed. Double-check the code.");
        return;
      }
      await onComplete(provider);
    } catch (err) {
      setCodeError(String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const oauthCode = useMemo(() => {
    if (!authorization?.instructions) return "";
    if (authorization.instructions.includes(":")) {
      return authorization.instructions.split(":").slice(1).join(":").trim();
    }
    return authorization.instructions;
  }, [authorization?.instructions]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="space-y-6 px-6 pb-6 pt-6">
        <div className="flex items-start gap-3">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onBack}
            className="mt-0.5"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-start gap-3">
            <div className="flex size-9 items-center justify-center rounded-full bg-secondary/60">
              <ModelSelectorLogo provider={provider.id} className="size-4" />
            </div>
            <div className="space-y-1">
              <DialogTitle>Connect {provider.name}</DialogTitle>
            <DialogDescription>
              Choose an authentication method for {provider.name}.
            </DialogDescription>
          </div>
        </div>
      </div>

      {provider.id === "opencode" && activeMethod?.type === "api" && (
        <div className="rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          OpenCode offers a free tier with curated models. Grab your key from
          the OpenCode dashboard.
          <Button
            type="button"
            variant="link"
            size="sm"
            className="px-0"
            onClick={() => void falckService.openInBrowser("https://opencode.ai/zen")}
          >
            Open OpenCode Zen
          </Button>
        </div>
      )}

      {methodIndex === null && (
        <div className="space-y-3">
          <div className="text-sm text-muted-foreground">
            Select how you want to connect.
          </div>
          <div className="grid gap-2">
            {resolvedMethods.map((method, index) => (
              <Button
                key={`${method.type}-${index}`}
                type="button"
                variant="outline"
                className="justify-between normal-case tracking-normal"
                onClick={() => void selectMethod(index)}
              >
                <span>{method.type === "api" ? "API key" : method.label}</span>
                <span className="text-xs text-muted-foreground">
                  {method.type === "api" ? "Paste a key" : "OAuth"}
                </span>
              </Button>
            ))}
          </div>
        </div>
      )}

      {activeMethod?.type === "api" && (
        <form onSubmit={handleApiSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="provider-api-key">
              {provider.name} API key
            </Label>
            <Input
              id="provider-api-key"
              type="password"
              placeholder="Enter API key"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
            {apiError && (
              <p className="text-sm font-medium text-destructive">{apiError}</p>
            )}
          </div>
          <Button
            type="submit"
            disabled={submitting}
            className="w-full normal-case tracking-normal"
          >
            {submitting ? "Saving..." : "Save key"}
          </Button>
        </form>
      )}

      {activeMethod?.type === "oauth" && (
        <div className="space-y-4">
          {state === "pending" && (
            <div className="text-sm text-muted-foreground">
              Connecting to {provider.name}...
            </div>
          )}
          {state === "error" && error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {authorization?.method === "code" && (
            <>
              <div className="text-sm text-muted-foreground">
                Complete the authorization in your browser, then paste the
                verification code below.
              </div>
              <form onSubmit={handleCodeSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="provider-oauth-code">Verification code</Label>
                  <Input
                    id="provider-oauth-code"
                    placeholder="Enter code"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                  />
                  {codeError && (
                    <p className="text-sm font-medium text-destructive">
                      {codeError}
                    </p>
                  )}
                </div>
                <Button
                  type="submit"
                  disabled={submitting}
                  className="w-full normal-case tracking-normal"
                >
                  {submitting ? "Verifying..." : "Confirm"}
                </Button>
              </form>
            </>
          )}

          {authorization?.method === "auto" && (
            <div className="space-y-3">
              <div className="text-sm text-muted-foreground">
                Follow the OAuth flow in your browser. We will complete the
                connection automatically.
              </div>
              {oauthCode && (
                <div className="rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  Confirmation code: <span className="font-mono">{oauthCode}</span>
                </div>
              )}
              <div className="text-sm text-muted-foreground">Waiting for confirmation...</div>
            </div>
          )}
        </div>
      )}

      {error && activeMethod?.type !== "oauth" && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      </div>
    </div>
  );
}

interface CustomProviderViewProps {
  config: OpenCodeConfigData | null;
  providers: OpenCodeProviderListItem[];
  onBack: () => void;
  onComplete: (providerName: string) => void;
}

function CustomProviderView({
  config,
  providers,
  onBack,
  onComplete,
}: CustomProviderViewProps) {
  const [form, setForm] = useState({
    providerID: "",
    name: "",
    baseURL: "",
    apiKey: "",
    models: [{ id: "", name: "" }],
    headers: [{ key: "", value: "" }],
    saving: false,
  });

  const [errors, setErrors] = useState({
    providerID: "" as string | null,
    name: "" as string | null,
    baseURL: "" as string | null,
    models: [{ id: "", name: "" }] as Array<{ id?: string; name?: string }>,
    headers: [{ key: "", value: "" }] as Array<{ key?: string; value?: string }>,
  });

  const updateModel = (index: number, field: "id" | "name", value: string) => {
    setForm((prev) => {
      const next = [...prev.models];
      next[index] = { ...next[index], [field]: value };
      return { ...prev, models: next };
    });
  };

  const updateHeader = (
    index: number,
    field: "key" | "value",
    value: string,
  ) => {
    setForm((prev) => {
      const next = [...prev.headers];
      next[index] = { ...next[index], [field]: value };
      return { ...prev, headers: next };
    });
  };

  const addModel = () => {
    setForm((prev) => ({
      ...prev,
      models: [...prev.models, { id: "", name: "" }],
    }));
    setErrors((prev) => ({
      ...prev,
      models: [...prev.models, {}],
    }));
  };

  const removeModel = (index: number) => {
    setForm((prev) => {
      if (prev.models.length <= 1) return prev;
      const next = [...prev.models];
      next.splice(index, 1);
      return { ...prev, models: next };
    });
    setErrors((prev) => {
      if (prev.models.length <= 1) return prev;
      const next = [...prev.models];
      next.splice(index, 1);
      return { ...prev, models: next };
    });
  };

  const addHeader = () => {
    setForm((prev) => ({
      ...prev,
      headers: [...prev.headers, { key: "", value: "" }],
    }));
    setErrors((prev) => ({
      ...prev,
      headers: [...prev.headers, {}],
    }));
  };

  const removeHeader = (index: number) => {
    setForm((prev) => {
      if (prev.headers.length <= 1) return prev;
      const next = [...prev.headers];
      next.splice(index, 1);
      return { ...prev, headers: next };
    });
    setErrors((prev) => {
      if (prev.headers.length <= 1) return prev;
      const next = [...prev.headers];
      next.splice(index, 1);
      return { ...prev, headers: next };
    });
  };

  const validate = () => {
    const providerID = form.providerID.trim();
    const name = form.name.trim();
    const baseURL = form.baseURL.trim();
    const apiKey = form.apiKey.trim();

    const env = apiKey.match(/^\{env:([^}]+)\}$/)?.[1]?.trim();
    const key = apiKey && !env ? apiKey : undefined;

    const idError = !providerID
      ? "Provider ID is required."
      : !/^[a-z0-9][a-z0-9-_]*$/.test(providerID)
        ? "Use lowercase letters, numbers, dashes, or underscores."
        : undefined;

    const nameError = !name ? "Name is required." : undefined;
    const urlError = !baseURL
      ? "Base URL is required."
      : !/^https?:\/\//.test(baseURL)
        ? "Base URL must start with http:// or https://"
        : undefined;

    const disabledProviders = config?.disabled_providers ?? [];
    const existingProvider = providers.find((p) => p.id === providerID);
    const existsError =
      idError || !existingProvider
        ? undefined
        : disabledProviders.includes(providerID)
          ? undefined
          : "Provider ID already exists.";

    const seenModels = new Set<string>();
    const modelErrors = form.models.map((model) => {
      const id = model.id.trim();
      const idError = !id
        ? "Model ID is required."
        : seenModels.has(id)
          ? "Duplicate model ID."
          : (() => {
              seenModels.add(id);
              return undefined;
            })();
      const nameError = !model.name.trim() ? "Model name is required." : undefined;
      return { id: idError, name: nameError };
    });

    const seenHeaders = new Set<string>();
    const headerErrors = form.headers.map((header) => {
      const key = header.key.trim();
      const value = header.value.trim();
      if (!key && !value) return {};
      const keyError = !key
        ? "Header key is required."
        : seenHeaders.has(key.toLowerCase())
          ? "Duplicate header."
          : (() => {
              seenHeaders.add(key.toLowerCase());
              return undefined;
            })();
      const valueError = !value ? "Header value is required." : undefined;
      return { key: keyError, value: valueError };
    });

    setErrors({
      providerID: idError ?? existsError ?? null,
      name: nameError ?? null,
      baseURL: urlError ?? null,
      models: modelErrors,
      headers: headerErrors,
    });

    const modelsValid = modelErrors.every((m) => !m.id && !m.name);
    const headersValid = headerErrors.every((h) => !h.key && !h.value);
    if (idError || existsError || nameError || urlError || !modelsValid || !headersValid) {
      return null;
    }

    const models = Object.fromEntries(
      form.models.map((model) => [model.id.trim(), { name: model.name.trim() }]),
    );

    const headers = Object.fromEntries(
      form.headers
        .map((header) => ({
          key: header.key.trim(),
          value: header.value.trim(),
        }))
        .filter((header) => header.key && header.value)
        .map((header) => [header.key, header.value]),
    );

    const options = {
      baseURL,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };

    return {
      providerID,
      name,
      key,
      config: {
        npm: OPENAI_COMPATIBLE,
        name,
        ...(env ? { env: [env] } : {}),
        options,
        models,
      },
    };
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (form.saving) return;

    const result = validate();
    if (!result) return;

    setForm((prev) => ({ ...prev, saving: true }));
    try {
      const disabledProviders = config?.disabled_providers ?? [];
      const nextDisabled = disabledProviders.filter((id) => id !== result.providerID);

      if (result.key) {
        await opencodeService.setAuth(result.providerID, result.key);
      }

      await opencodeService.updateConfig({
        provider: { [result.providerID]: result.config },
        disabled_providers: nextDisabled,
      });

      await onComplete(result.name);
    } catch (err) {
      setErrors((prev) => ({
        ...prev,
        providerID: String(err),
      }));
    } finally {
      setForm((prev) => ({ ...prev, saving: false }));
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="space-y-6 px-6 pb-6 pt-6">
        <div className="flex items-start gap-3">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onBack}
            className="mt-0.5"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-start gap-3">
            <div className="flex size-9 items-center justify-center rounded-full bg-secondary/60">
              <ModelSelectorLogo provider="synthetic" className="size-4" />
          </div>
          <div className="space-y-1">
            <DialogTitle>Custom provider</DialogTitle>
            <DialogDescription>
              Add an OpenAI-compatible provider by base URL and model list.
            </DialogDescription>
          </div>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="custom-provider-id">Provider ID</Label>
          <Input
            id="custom-provider-id"
            placeholder="my-provider"
            value={form.providerID}
            onChange={(event) =>
              setForm((prev) => ({ ...prev, providerID: event.target.value }))
            }
          />
          {errors.providerID && (
            <p className="text-sm font-medium text-destructive">{errors.providerID}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="custom-provider-name">Display name</Label>
          <Input
            id="custom-provider-name"
            placeholder="Custom provider"
            value={form.name}
            onChange={(event) =>
              setForm((prev) => ({ ...prev, name: event.target.value }))
            }
          />
          {errors.name && (
            <p className="text-sm font-medium text-destructive">{errors.name}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="custom-provider-url">Base URL</Label>
          <Input
            id="custom-provider-url"
            placeholder="https://api.example.com/v1"
            value={form.baseURL}
            onChange={(event) =>
              setForm((prev) => ({ ...prev, baseURL: event.target.value }))
            }
          />
          {errors.baseURL && (
            <p className="text-sm font-medium text-destructive">{errors.baseURL}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="custom-provider-key">API key (optional)</Label>
          <Input
            id="custom-provider-key"
            placeholder="{env:MY_API_KEY}"
            value={form.apiKey}
            onChange={(event) =>
              setForm((prev) => ({ ...prev, apiKey: event.target.value }))
            }
          />
          <p className="text-xs text-muted-foreground">
            You can reference an environment variable with {"{env:KEY}"}.
          </p>
        </div>

        <div className="space-y-3">
          <Label className="text-xs uppercase tracking-[0.25em] text-muted-foreground">
            Models
          </Label>
          {form.models.map((model, index) => (
            <div key={`model-${index}`} className="flex flex-col gap-2 sm:flex-row">
              <div className="flex-1 space-y-2">
                <Label className="text-xs">Model ID</Label>
                <Input
                  value={model.id}
                  placeholder="model-id"
                  onChange={(event) =>
                    updateModel(index, "id", event.target.value)
                  }
                />
                {errors.models[index]?.id && (
                  <p className="text-sm font-medium text-destructive">
                    {errors.models[index]?.id}
                  </p>
                )}
              </div>
              <div className="flex-1 space-y-2">
                <Label className="text-xs">Model name</Label>
                <Input
                  value={model.name}
                  placeholder="Model name"
                  onChange={(event) =>
                    updateModel(index, "name", event.target.value)
                  }
                />
                {errors.models[index]?.name && (
                  <p className="text-sm font-medium text-destructive">
                    {errors.models[index]?.name}
                  </p>
                )}
              </div>
              <div className="flex items-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="mt-6"
                  onClick={() => removeModel(index)}
                  disabled={form.models.length <= 1}
                >
                  x
                </Button>
              </div>
            </div>
          ))}
          <Button
            type="button"
            variant="ghost"
            className="normal-case tracking-normal"
            onClick={addModel}
          >
            Add model
          </Button>
        </div>

        <div className="space-y-3">
          <Label className="text-xs uppercase tracking-[0.25em] text-muted-foreground">
            Headers
          </Label>
          {form.headers.map((header, index) => (
            <div key={`header-${index}`} className="flex flex-col gap-2 sm:flex-row">
              <div className="flex-1 space-y-2">
                <Label className="text-xs">Key</Label>
                <Input
                  value={header.key}
                  placeholder="X-Header"
                  onChange={(event) =>
                    updateHeader(index, "key", event.target.value)
                  }
                />
                {errors.headers[index]?.key && (
                  <p className="text-sm font-medium text-destructive">
                    {errors.headers[index]?.key}
                  </p>
                )}
              </div>
              <div className="flex-1 space-y-2">
                <Label className="text-xs">Value</Label>
                <Input
                  value={header.value}
                  placeholder="Value"
                  onChange={(event) =>
                    updateHeader(index, "value", event.target.value)
                  }
                />
                {errors.headers[index]?.value && (
                  <p className="text-sm font-medium text-destructive">
                    {errors.headers[index]?.value}
                  </p>
                )}
              </div>
              <div className="flex items-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="mt-6"
                  onClick={() => removeHeader(index)}
                  disabled={form.headers.length <= 1}
                >
                  x
                </Button>
              </div>
            </div>
          ))}
          <Button
            type="button"
            variant="ghost"
            className="normal-case tracking-normal"
            onClick={addHeader}
          >
            Add header
          </Button>
        </div>

        <Button
          type="submit"
          className="w-full normal-case tracking-normal"
          disabled={form.saving}
        >
          {form.saving ? "Saving..." : "Save provider"}
        </Button>
      </form>
      </div>
    </div>
  );
}

const OpenCodeSettingsContent = ({ active }: OpenCodeSettingsContentProps) => {
  const {
    providerList,
    providerAuth,
    config,
    modelProviders,
    loadingProviders,
    error,
    success,
    setError,
    showSuccess,
    loadProviders,
  } = useOpenCodeProviders(active);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogView, setDialogView] = useState<ProviderDialogView>("select");
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
    null,
  );

  const providers = providerList.all;
  const connectedIds = useMemo(
    () => new Set(providerList.connected ?? []),
    [providerList.connected],
  );
  const connectedProviders = useMemo(
    () => providers.filter((provider) => connectedIds.has(provider.id)),
    [providers, connectedIds],
  );

  const popularProviders = useMemo(() => {
    return providers
      .filter((provider) => POPULAR_PROVIDERS.includes(provider.id))
      .sort(
        (a, b) =>
          POPULAR_PROVIDERS.indexOf(a.id) -
          POPULAR_PROVIDERS.indexOf(b.id),
      );
  }, [providers]);

  const popularAvailable = useMemo(
    () => popularProviders.filter((provider) => !connectedIds.has(provider.id)),
    [popularProviders, connectedIds],
  );

  const otherProviders = useMemo(() => {
    return providers
      .filter((provider) => !POPULAR_PROVIDERS.includes(provider.id))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [providers]);

  useEffect(() => {
    if (!selectedProviderId) {
      return;
    }
    const stillAvailable = providers.some(
      (provider) => provider.id === selectedProviderId,
    );
    if (!stillAvailable) {
      setSelectedProviderId(null);
    }
  }, [providers, selectedProviderId]);

  const handleDialogOpenChange = (nextOpen: boolean) => {
    setDialogOpen(nextOpen);
    if (!nextOpen) {
      setDialogView("select");
      setSelectedProviderId(null);
    }
  };

  const openConnectDialog = (providerId: string) => {
    setSelectedProviderId(providerId);
    setDialogView("connect");
    setDialogOpen(true);
  };

  const openCustomDialog = () => {
    setSelectedProviderId(null);
    setDialogView("custom");
    setDialogOpen(true);
  };

  const handleDisconnect = async (provider: OpenCodeProviderListItem) => {
    setError(null);
    try {
      if (isConfigCustom(config, provider.id)) {
        await opencodeService.removeAuth(provider.id).catch(() => undefined);
        const disabled = config.disabled_providers ?? [];
        const nextDisabled = disabled.includes(provider.id)
          ? disabled
          : [...disabled, provider.id];
        await opencodeService.updateConfig({ disabled_providers: nextDisabled });
      } else {
        await opencodeService.removeAuth(provider.id);
      }
      await opencodeService.dispose().catch(() => undefined);
      await loadProviders();
      showSuccess(`Disconnected ${provider.name}.`);
    } catch (err) {
      setError(`Failed to disconnect: ${String(err)}`);
    }
  };

  const handleConnected = async (provider: OpenCodeProviderListItem) => {
    setError(null);
    try {
      await opencodeService.dispose().catch(() => undefined);
      await loadProviders();
      showSuccess(`Connected ${provider.name}.`);
      setDialogOpen(false);
      setDialogView("select");
      setSelectedProviderId(null);
    } catch (err) {
      setError(`Failed to refresh providers: ${String(err)}`);
    }
  };

  const handleCustomConnected = async (providerName: string) => {
    setError(null);
    try {
      await opencodeService.dispose().catch(() => undefined);
      await loadProviders();
      showSuccess(`Connected ${providerName}.`);
      setDialogOpen(false);
      setDialogView("select");
      setSelectedProviderId(null);
    } catch (err) {
      setError(`Failed to refresh providers: ${String(err)}`);
    }
  };

  const selectedProvider = selectedProviderId
    ? providers.find((provider) => provider.id === selectedProviderId) || null
    : null;

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">Connected providers</h3>
            <p className="text-xs text-muted-foreground">
              Manage API keys and OAuth connections.
            </p>
          </div>
          <Button
            type="button"
            variant="secondary"
            className="normal-case tracking-normal"
            onClick={() => {
              setDialogView("select");
              setDialogOpen(true);
            }}
            disabled={loadingProviders || providers.length === 0}
          >
            {loadingProviders ? "Loading providers..." : "Connect provider"}
          </Button>
        </div>

        <div className="rounded-lg border border-border/60 bg-secondary/10">
          {loadingProviders ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">
              Loading providers...
            </div>
          ) : connectedProviders.length === 0 ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">
              No providers connected yet.
            </div>
          ) : (
            connectedProviders.map((provider) => (
              <div
                key={provider.id}
                className="flex flex-wrap items-center justify-between gap-4 border-b border-border/50 px-4 py-3 last:border-none"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <ModelSelectorLogo provider={provider.id} className="size-4" />
                  <span className="text-sm font-semibold text-foreground truncate">
                    {provider.name}
                  </span>
                  <Badge variant="outline" className="text-[0.6rem]">
                    {providerTagLabel(provider, config)}
                  </Badge>
                </div>
                {canDisconnect(provider) ? (
                  <Button
                    type="button"
                    variant="ghost"
                    className="normal-case tracking-normal"
                    onClick={() => void handleDisconnect(provider)}
                  >
                    Disconnect
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    Connected from environment variables
                  </span>
                )}
              </div>
            ))
          )}
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Popular providers</h3>
        <div className="rounded-lg border border-border/60 bg-secondary/10">
          {loadingProviders ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">
              Loading providers...
            </div>
          ) : popularAvailable.length === 0 ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">
              All popular providers are already connected.
            </div>
          ) : (
            popularAvailable.map((provider) => (
              <div
                key={provider.id}
                className="flex flex-wrap items-center justify-between gap-4 border-b border-border/50 px-4 py-3 last:border-none"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <ModelSelectorLogo provider={provider.id} className="size-4" />
                    <span className="text-sm font-semibold text-foreground">
                      {provider.name}
                    </span>
                    {provider.id === "opencode" && (
                      <Badge variant="secondary" className="text-[0.6rem]">
                        Recommended
                      </Badge>
                    )}
                  </div>
                  {getProviderNote(provider.id) && (
                    <span className="text-xs text-muted-foreground">
                      {getProviderNote(provider.id)}
                    </span>
                  )}
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  className="normal-case tracking-normal"
                  onClick={() => openConnectDialog(provider.id)}
                >
                  Connect
                </Button>
              </div>
            ))
          )}

          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border/50 px-4 py-3">
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex items-center gap-2">
                <ModelSelectorLogo provider="synthetic" className="size-4" />
                <span className="text-sm font-semibold text-foreground">
                  Custom provider
                </span>
                <Badge variant="outline" className="text-[0.6rem]">
                  Custom
                </Badge>
              </div>
              <span className="text-xs text-muted-foreground">
                Add an OpenAI-compatible provider by base URL.
              </span>
            </div>
            <Button
              type="button"
              variant="secondary"
              className="normal-case tracking-normal"
              onClick={openCustomDialog}
            >
              Connect
            </Button>
          </div>
        </div>

        <Button
          type="button"
          variant="ghost"
          className="px-0 normal-case tracking-normal text-left"
          onClick={() => {
            setDialogView("select");
            setDialogOpen(true);
          }}
        >
          View all providers
        </Button>
      </section>

      <Dialog open={dialogOpen} onOpenChange={handleDialogOpenChange}>
        <DialogContent className="max-h-[85vh] max-w-2xl flex flex-col overflow-hidden p-0">
          {dialogView === "select" && (
            <ProviderSelectView
              loading={loadingProviders}
              popularProviders={popularProviders}
              otherProviders={otherProviders}
              onSelectProvider={openConnectDialog}
              onSelectCustom={openCustomDialog}
            />
          )}
          {dialogView === "connect" && selectedProvider && (
            <ProviderConnectView
              provider={selectedProvider}
              methods={providerAuth[selectedProvider.id] ?? []}
              onBack={() => {
                setDialogView("select");
                setSelectedProviderId(null);
              }}
              onComplete={handleConnected}
            />
          )}
          {dialogView === "custom" && (
            <CustomProviderView
              config={config}
              providers={providers}
              onBack={() => setDialogView("select")}
              onComplete={handleCustomConnected}
            />
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
          ) : modelProviders.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/70 bg-secondary/10 px-4 py-6 text-sm text-muted-foreground">
              No providers available yet. Install or configure OpenCode to add
              providers.
            </div>
          ) : (
            modelProviders.map((provider) => (
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
        <CardDescription>Connect providers and manage models.</CardDescription>
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
      <DialogContent className="max-h-[85vh] flex flex-col gap-4 overflow-hidden">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle>OpenCode settings</DialogTitle>
          <DialogDescription>Connect providers and manage models.</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <OpenCodeSettingsContent active={open} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
