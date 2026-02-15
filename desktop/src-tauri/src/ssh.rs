use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::blocking::run_blocking;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SSHKey {
    pub name: String,
    pub public_key: String,
    pub private_key_path: String,
    pub fingerprint: String,
    pub created_at: String,
}

fn get_system_ssh_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "Could not determine home directory".to_string())?;

    let ssh_dir = Path::new(&home).join(".ssh");
    fs::create_dir_all(&ssh_dir).map_err(|e| format!("Failed to create ~/.ssh: {e}"))?;
    Ok(ssh_dir)
}

fn normalize_key_name(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Key name is required".to_string());
    }

    let mut sanitized = String::new();
    for ch in trimmed.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            sanitized.push(ch);
        } else if ch.is_whitespace() {
            sanitized.push('-');
        }
    }

    let sanitized = sanitized.trim_matches('-').trim_matches('_').to_string();

    let sanitized = sanitized
        .strip_prefix("id_")
        .unwrap_or(sanitized.as_str())
        .to_string();

    if sanitized.is_empty() {
        return Err("Key name must include letters or numbers".to_string());
    }

    Ok(sanitized)
}

fn get_key_fingerprint(public_key_path: &Path) -> Result<String, String> {
    let output = Command::new("ssh-keygen")
        .args(["-l", "-f"])
        .arg(public_key_path)
        .output()
        .map_err(|e| format!("Failed to run ssh-keygen: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ssh-keygen failed: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let fingerprint = stdout
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| "Failed to parse fingerprint".to_string())?
        .to_string();

    Ok(fingerprint)
}

fn read_ssh_key(private_key_path: &Path) -> Result<SSHKey, String> {
    let public_key_path = private_key_path.with_extension("pub");

    let public_key = fs::read_to_string(&public_key_path)
        .map_err(|e| format!("Failed to read public key: {e}"))?
        .trim()
        .to_string();

    let fingerprint = get_key_fingerprint(&public_key_path)?;

    let file_name = private_key_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown");
    let name = file_name
        .strip_prefix("id_")
        .unwrap_or(file_name)
        .to_string();

    let created_at = fs::metadata(private_key_path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|| "".to_string());

    Ok(SSHKey {
        name,
        public_key,
        private_key_path: private_key_path.to_string_lossy().to_string(),
        fingerprint,
        created_at,
    })
}

fn detect_os() -> String {
    if cfg!(target_os = "macos") {
        "macos".to_string()
    } else if cfg!(target_os = "linux") {
        "linux".to_string()
    } else if cfg!(target_os = "windows") {
        "windows".to_string()
    } else {
        "unknown".to_string()
    }
}

pub fn generate_ssh_key(
    key_name: &str,
    passphrase: Option<&str>,
    key_type: &str,
) -> Result<SSHKey, String> {
    let sanitized_name = normalize_key_name(key_name)?;
    let ssh_dir = get_system_ssh_dir()?;
    let private_key_path = ssh_dir.join(format!("id_{}", sanitized_name));
    let public_key_path = private_key_path.with_extension("pub");

    if private_key_path.exists() || public_key_path.exists() {
        return Err("A key with that name already exists.".to_string());
    }

    let mut cmd = Command::new("ssh-keygen");
    if key_type == "rsa" {
        cmd.args(["-t", "rsa", "-b", "4096"]);
    } else {
        cmd.args(["-t", "ed25519"]);
    }
    cmd.args(["-f"])
        .arg(&private_key_path)
        .args(["-C", key_name])
        .args(["-N", passphrase.unwrap_or("")]);

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run ssh-keygen: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ssh-keygen failed: {}", stderr.trim()));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&private_key_path, fs::Permissions::from_mode(0o600));
    }

    read_ssh_key(&private_key_path)
}

pub fn list_available_keys() -> Result<Vec<SSHKey>, String> {
    let ssh_dir = get_system_ssh_dir()?;
    let mut keys = Vec::new();

    if !ssh_dir.exists() {
        return Ok(keys);
    }

    for entry in fs::read_dir(&ssh_dir).map_err(|e| format!("Failed to read ~/.ssh: {e}"))? {
        let entry = entry.map_err(|e| format!("Failed to read ~/.ssh entry: {e}"))?;
        let path = entry.path();

        if !path.is_file() {
            continue;
        }

        if path.extension().map(|ext| ext == "pub").unwrap_or(false) {
            continue;
        }

        let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if matches!(file_name, "config" | "known_hosts" | "authorized_keys") {
            continue;
        }

        let public_key_path = path.with_extension("pub");
        if !public_key_path.exists() {
            continue;
        }

        if let Ok(key) = read_ssh_key(&path) {
            keys.push(key);
        }
    }

    Ok(keys)
}

pub fn add_key_to_agent(private_key_path: &Path, passphrase: Option<&str>) -> Result<(), String> {
    if !private_key_path.exists() {
        return Err("Private key not found.".to_string());
    }

    if cfg!(target_os = "windows") {
        let _ = Command::new("powershell")
            .args([
                "-Command",
                "Start-Service ssh-agent -ErrorAction SilentlyContinue",
            ])
            .output();
    }

    let mut cmd = Command::new("ssh-add");
    if cfg!(target_os = "macos") {
        cmd.arg("-K");
    }
    cmd.arg(private_key_path);

    if let Some(pass) = passphrase {
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to run ssh-add: {e}"))?;

        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(pass.as_bytes())
                .and_then(|_| stdin.write_all(b"\n"))
                .map_err(|e| format!("Failed to send passphrase: {e}"))?;
        }

        let output = child
            .wait_with_output()
            .map_err(|e| format!("Failed to wait for ssh-add: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("ssh-add failed: {}", stderr.trim()));
        }
    } else {
        let output = cmd
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| format!("Failed to run ssh-add: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("ssh-add failed: {}", stderr.trim()));
        }
    }

    Ok(())
}

pub fn test_github_connection(private_key_path: &Path) -> Result<bool, String> {
    let output = Command::new("ssh")
        .args([
            "-i",
            private_key_path
                .to_str()
                .ok_or_else(|| "Invalid key path".to_string())?,
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=no",
            "git@github.com",
        ])
        .output()
        .map_err(|e| format!("Failed to run ssh: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{stdout}\n{stderr}");
    Ok(combined.contains("successfully authenticated"))
}

#[tauri::command]
pub async fn generate_new_ssh_key(
    name: String,
    passphrase: Option<String>,
    key_type: String,
) -> Result<SSHKey, String> {
    run_blocking(move || generate_ssh_key(&name, passphrase.as_deref(), &key_type)).await
}

#[tauri::command]
pub async fn list_ssh_keys() -> Result<Vec<SSHKey>, String> {
    run_blocking(list_available_keys).await
}

#[tauri::command]
pub async fn add_ssh_key_to_agent(
    private_key_path: String,
    passphrase: Option<String>,
) -> Result<(), String> {
    run_blocking(move || add_key_to_agent(Path::new(&private_key_path), passphrase.as_deref()))
        .await
}

#[tauri::command]
pub async fn test_ssh_github(private_key_path: String) -> Result<bool, String> {
    run_blocking(move || test_github_connection(Path::new(&private_key_path))).await
}

#[tauri::command]
pub async fn get_current_os() -> String {
    detect_os()
}
