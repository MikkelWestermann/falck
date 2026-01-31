import { invoke } from "@tauri-apps/api/core";

export interface SSHKey {
  name: string;
  public_key: string;
  private_key_path: string;
  fingerprint: string;
  created_at: string;
}

export type KeyType = "rsa" | "ed25519";
export type OS = "macos" | "linux" | "windows" | "unknown";

export const sshService = {
  async generateNewKey(
    name: string,
    passphrase: string | null,
    keyType: KeyType = "ed25519",
  ): Promise<SSHKey> {
    return invoke<SSHKey>("generate_new_ssh_key", {
      name,
      passphrase,
      keyType,
    });
  },

  async listKeys(): Promise<SSHKey[]> {
    return invoke<SSHKey[]>("list_ssh_keys");
  },

  async addKeyToAgent(
    privateKeyPath: string,
    passphrase: string | null,
  ): Promise<void> {
    return invoke<void>("add_ssh_key_to_agent", {
      privateKeyPath,
      passphrase,
    });
  },

  async testGitHubConnection(privateKeyPath: string): Promise<boolean> {
    return invoke<boolean>("test_ssh_github", {
      privateKeyPath,
    });
  },

  async getOS(): Promise<OS> {
    return invoke<OS>("get_current_os");
  },

  getSetupInstructions(os: OS, publicKeyPath: string) {
    const keyPath = publicKeyPath;
    switch (os) {
      case "macos":
        return {
          title: "Add SSH Key to GitHub (macOS)",
          steps: [
            `Copy your public key: pbcopy < "${keyPath}"`,
            "Go to GitHub Settings → SSH and GPG keys",
            'Click "New SSH key"',
            "Paste your public key and add a title",
            'Click "Add SSH key"',
          ],
        };
      case "linux":
        return {
          title: "Add SSH Key to GitHub (Linux)",
          steps: [
            `Copy your public key: cat "${keyPath}" | xclip -selection clipboard`,
            "Or manually copy the contents of your .pub file",
            "Go to GitHub Settings → SSH and GPG keys",
            'Click "New SSH key"',
            "Paste your public key and add a title",
            'Click "Add SSH key"',
          ],
        };
      case "windows":
        return {
          title: "Add SSH Key to GitHub (Windows)",
          steps: [
            "Open PowerShell and run:",
            `type "${keyPath}" | Set-Clipboard`,
            "Go to GitHub Settings → SSH and GPG keys",
            'Click "New SSH key"',
            "Paste your public key and add a title",
            'Click "Add SSH key"',
          ],
        };
      default:
        return {
          title: "Add SSH Key to GitHub",
          steps: [
            "Copy your public key content",
            "Go to GitHub Settings → SSH and GPG keys",
            'Click "New SSH key"',
            "Paste your public key and add a title",
            'Click "Add SSH key"',
          ],
        };
    }
  },
};
