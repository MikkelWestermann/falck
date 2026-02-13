use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Serialize;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadResult {
    pub path: String,
    pub relative_path: String,
    pub filename: String,
    pub mime: String,
}

fn sanitize_component(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == '.' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn sanitize_filename(name: &str) -> String {
    let fallback = "upload";
    let base = Path::new(name)
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or(fallback);
    let sanitized = sanitize_component(base);
    if sanitized.is_empty() {
        fallback.to_string()
    } else {
        sanitized
    }
}

#[tauri::command]
pub fn save_temp_upload(
    repo_path: String,
    message_id: String,
    filename: String,
    mime: Option<String>,
    data_base64: String,
) -> Result<UploadResult, String> {
    let repo = PathBuf::from(repo_path);
    if !repo.exists() {
        return Err("Repo path not found.".to_string());
    }

    let upload_dir = repo
        .join(".falck")
        .join("uploads")
        .join(sanitize_component(&message_id));
    std::fs::create_dir_all(&upload_dir).map_err(|e| e.to_string())?;

    let safe_name = sanitize_filename(&filename);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let stored_name = format!("{}_{}", stamp, safe_name);
    let mut target_path = upload_dir.join(&stored_name);
    let mut counter = 0;
    while target_path.exists() {
        counter += 1;
        let candidate = format!("{}_{}_{}", stamp, counter, safe_name);
        target_path = upload_dir.join(candidate);
    }

    let payload = data_base64.trim();
    let bytes = STANDARD
        .decode(payload.as_bytes())
        .map_err(|e| format!("Invalid base64 payload: {}", e))?;
    std::fs::write(&target_path, bytes).map_err(|e| e.to_string())?;

    let relative_path = target_path
        .strip_prefix(&repo)
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|_| target_path.to_string_lossy().to_string());

    let display_name = if filename.trim().is_empty() {
        safe_name
    } else {
        filename.trim().to_string()
    };

    Ok(UploadResult {
        path: target_path.to_string_lossy().to_string(),
        relative_path,
        filename: display_name,
        mime: mime.unwrap_or_else(|| "application/octet-stream".to_string()),
    })
}
