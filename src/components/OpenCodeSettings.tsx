import { useEffect, useState } from "react";
import { Provider, opencodeService } from "../services/opencodeService";

interface OpenCodeSettingsProps {
  onClose: () => void;
}

export function OpenCodeSettings({ onClose }: OpenCodeSettingsProps) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [selectedProvider, setSelectedProvider] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void loadProviders();
  }, []);

  const loadProviders = async () => {
    try {
      const config = await opencodeService.getProviders();
      setProviders(config.providers);
      setSelectedProvider(config.providers[0]?.name || "");
      setError("");
    } catch (err) {
      setError(`Failed to load providers: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleSetAuth = async () => {
    if (!apiKey.trim()) {
      setError("API key cannot be empty.");
      return;
    }

    setLoading(true);
    try {
      await opencodeService.setAuth(selectedProvider, apiKey);
      setSuccess(`Authentication set for ${selectedProvider}`);
      setApiKey("");
      setTimeout(() => setSuccess(""), 3000);
      setError("");
    } catch (err) {
      setError(`Failed to set authentication: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <header className="modal-header">
          <h2>OpenCode settings</h2>
          <button className="btn ghost tiny" onClick={onClose}>
            Close
          </button>
        </header>

        <section className="modal-section">
          <h3>API keys</h3>
          <div className="field">
            <label>Provider</label>
            <select
              value={selectedProvider}
              onChange={(e) => setSelectedProvider(e.target.value)}
            >
              {providers.map((provider) => (
                <option key={provider.name} value={provider.name}>
                  {provider.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>API key</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Enter API key"
            />
          </div>
          <button className="btn primary" onClick={handleSetAuth} disabled={loading}>
            {loading ? "Saving…" : "Save key"}
          </button>
        </section>

        <section className="modal-section">
          <h3>Available models</h3>
          <div className="modal-list">
            {providers.map((provider) => (
              <div key={provider.name} className="modal-list-item">
                <strong>{provider.name}</strong>
                <ul>
                  {provider.models.map((model) => (
                    <li key={model}>{model}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        {error && <div className="notice error">{error}</div>}
        {success && <div className="notice success">{success}</div>}
      </div>
    </div>
  );
}
