import { useEffect, useState } from "react";
import { useForm } from "@tanstack/react-form";
import { zodValidator } from "@tanstack/zod-form-adapter";

import { FormField, FormSelect } from "@/components/form/FormField";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { setAPIKeySchema } from "@/schemas/forms";
import { Provider, opencodeService } from "@/services/opencodeService";

interface OpenCodeSettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function OpenCodeSettings({ open, onOpenChange }: OpenCodeSettingsProps) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const form = useForm({
    defaultValues: {
      provider: "",
      apiKey: "",
    },
    onSubmit: async ({ value }) => {
      setLoading(true);
      setError(null);
      try {
        await opencodeService.setAuth(value.provider, value.apiKey);
        setSuccess(`Authentication set for ${value.provider}`);
        form.reset({ provider: value.provider, apiKey: "" });
        setTimeout(() => setSuccess(null), 3000);
      } catch (err) {
        setError(`Failed to set authentication: ${String(err)}`);
      } finally {
        setLoading(false);
      }
    },
    validatorAdapter: zodValidator(),
  });

  useEffect(() => {
    if (!open) {
      return;
    }
    void loadProviders();
  }, [open]);

  const loadProviders = async () => {
    setLoading(true);
    try {
      const config = await opencodeService.getProviders();
      setProviders(config.providers);
      const initialProvider = config.providers[0]?.name || "";
      if (initialProvider) {
        form.reset({ provider: initialProvider, apiKey: "" });
      }
      setError(null);
    } catch (err) {
      setError(`Failed to load providers: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  const providerOptions = providers.map((provider) => ({
    label: provider.name,
    value: provider.name,
  }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>OpenCode settings</DialogTitle>
          <DialogDescription>Configure API keys and view models.</DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void form.handleSubmit();
          }}
          className="space-y-4"
        >
          <form.Field
            name="provider"
            validators={{ onChange: zodValidator(setAPIKeySchema.shape.provider) }}
          >
            {(field) => (
              <FormSelect
                field={field}
                label="Provider"
                options={providerOptions}
                required
              />
            )}
          </form.Field>
          <form.Field
            name="apiKey"
            validators={{ onChange: zodValidator(setAPIKeySchema.shape.apiKey) }}
          >
            {(field) => (
              <FormField
                field={field}
                label="API key"
                placeholder="Enter API key"
                type="password"
                required
              />
            )}
          </form.Field>

          <Button type="submit" disabled={loading} className="w-full">
            {loading ? "Saving…" : "Save key"}
          </Button>
        </form>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold">Available models</h3>
          <div className="grid gap-3">
            {providers.map((provider) => (
              <div
                key={provider.name}
                className="rounded-lg border-2 border-border bg-secondary/20 p-3 shadow-[var(--shadow-xs)]"
              >
                <div className="text-sm font-semibold text-foreground">
                  {provider.name}
                </div>
                <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                  {provider.models.map((model) => (
                    <li key={model}>{model}</li>
                  ))}
                </ul>
              </div>
            ))}
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
      </DialogContent>
    </Dialog>
  );
}
