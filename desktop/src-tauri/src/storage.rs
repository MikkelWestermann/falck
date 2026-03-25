use git2::Repository;
use keyring_core::{Entry, Error as KeyringError};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use tauri::{AppHandle, Manager, Runtime};

const DEFAULT_REPO_DIR_KEY: &str = "default_repo_dir";
const BACKEND_MODE_KEY: &str = "backend_mode";
const GITHUB_TOKEN_SERVICE_SUFFIX: &str = "github";
const GITHUB_TOKEN_USERNAME: &str = "access_token";
const OPENCODE_IMAGE_SETTINGS_KEY: &str = "opencode_image_settings";
const OPENCODE_IMAGE_OPENAI_SERVICE_SUFFIX: &str = "opencode.image.openai";
const OPENCODE_IMAGE_AZURE_SERVICE_SUFFIX: &str = "opencode.image.azure";
const OPENCODE_IMAGE_API_KEY_USERNAME: &str = "api_key";

static KEYRING_INIT: OnceLock<Result<(), String>> = OnceLock::new();

#[derive(Debug, Serialize, Clone)]
pub struct SavedRepo {
    pub name: String,
    pub path: String,
    pub last_opened: i64,
}

#[derive(Debug, Serialize, Clone)]
pub struct StoredContainer {
    pub id: String,
    pub repo_path: String,
    pub app_id: Option<String>,
    pub name: String,
    pub vm: String,
    pub image: Option<String>,
    pub created_at: i64,
    pub last_used: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct StoredOpencodeImageSettings {
    pub default_provider: Option<String>,
    pub azure_endpoint: Option<String>,
    pub azure_deployment_name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BackendMode {
    Host,
    Virtualized,
}

fn parse_backend_mode(value: &str) -> Option<BackendMode> {
    match value.trim().to_lowercase().as_str() {
        "host" => Some(BackendMode::Host),
        "virtualized" => Some(BackendMode::Virtualized),
        _ => None,
    }
}

fn open_db<R: Runtime>(app: &AppHandle<R>) -> Result<Connection, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let db_path = data_dir.join("repos.sqlite");
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS repos (
            path TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            last_opened INTEGER NOT NULL
        )",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS containers (
            id TEXT PRIMARY KEY,
            repo_path TEXT NOT NULL,
            app_id TEXT,
            name TEXT NOT NULL,
            vm TEXT NOT NULL,
            image TEXT,
            created_at INTEGER NOT NULL,
            last_used INTEGER NOT NULL
        )",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

fn default_repo_dir<R: Runtime>(app: &AppHandle<R>) -> Result<String, String> {
    let home_dir = app.path().home_dir().map_err(|e| e.to_string())?;
    Ok(home_dir.join("falck").to_string_lossy().to_string())
}

fn ensure_keyring_store() -> Result<(), String> {
    match KEYRING_INIT
        .get_or_init(|| keyring::use_native_store(true).map_err(|err| err.to_string()))
    {
        Ok(()) => Ok(()),
        Err(err) => Err(err.clone()),
    }
}

fn github_token_entry<R: Runtime>(app: &AppHandle<R>) -> Result<Entry, String> {
    keyring_entry(app, GITHUB_TOKEN_SERVICE_SUFFIX, GITHUB_TOKEN_USERNAME)
}

fn keyring_entry<R: Runtime>(
    app: &AppHandle<R>,
    service_suffix: &str,
    username: &str,
) -> Result<Entry, String> {
    ensure_keyring_store()?;
    let identifier = app.config().identifier.clone();
    let service = format!("{}.{}", identifier, service_suffix);
    Entry::new(&service, username).map_err(|e| e.to_string())
}

fn is_missing_keyring_entry(err: &KeyringError) -> bool {
    matches!(err, KeyringError::NoEntry)
}

pub fn get_default_repo_dir<R: Runtime>(app: &AppHandle<R>) -> Result<String, String> {
    let conn = open_db(app)?;
    let mut stmt = conn
        .prepare("SELECT value FROM settings WHERE key = ?1")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query(params![DEFAULT_REPO_DIR_KEY])
        .map_err(|e| e.to_string())?;
    if let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let value: String = row.get(0).map_err(|e| e.to_string())?;
        if !value.trim().is_empty() {
            return Ok(value);
        }
    }

    let fallback = default_repo_dir(app)?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![DEFAULT_REPO_DIR_KEY, fallback],
    )
    .map_err(|e| e.to_string())?;
    Ok(fallback)
}

pub fn set_default_repo_dir<R: Runtime>(app: &AppHandle<R>, path: &str) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Default repo directory cannot be empty.".to_string());
    }
    let conn = open_db(app)?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![DEFAULT_REPO_DIR_KEY, trimmed],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn get_backend_mode_raw<R: Runtime>(app: &AppHandle<R>) -> Result<Option<BackendMode>, String> {
    let conn = open_db(app)?;
    let mut stmt = conn
        .prepare("SELECT value FROM settings WHERE key = ?1")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query(params![BACKEND_MODE_KEY])
        .map_err(|e| e.to_string())?;
    if let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let value: String = row.get(0).map_err(|e| e.to_string())?;
        if let Some(mode) = parse_backend_mode(&value) {
            return Ok(Some(mode));
        }
    }
    Ok(None)
}

pub fn set_backend_mode<R: Runtime>(app: &AppHandle<R>, mode: BackendMode) -> Result<(), String> {
    let conn = open_db(app)?;
    let value = match mode {
        BackendMode::Host => "host",
        BackendMode::Virtualized => "virtualized",
    };
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![BACKEND_MODE_KEY, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn get_setting_value<R: Runtime>(app: &AppHandle<R>, key: &str) -> Result<Option<String>, String> {
    let conn = open_db(app)?;
    let mut stmt = conn
        .prepare("SELECT value FROM settings WHERE key = ?1")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query(params![key]).map_err(|e| e.to_string())?;
    if let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let value: String = row.get(0).map_err(|e| e.to_string())?;
        return Ok(Some(value));
    }
    Ok(None)
}

fn set_setting_value<R: Runtime>(app: &AppHandle<R>, key: &str, value: &str) -> Result<(), String> {
    let conn = open_db(app)?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn clear_setting_value<R: Runtime>(app: &AppHandle<R>, key: &str) -> Result<(), String> {
    let conn = open_db(app)?;
    conn.execute("DELETE FROM settings WHERE key = ?1", params![key])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn get_keyring_secret<R: Runtime>(
    app: &AppHandle<R>,
    service_suffix: &str,
    username: &str,
) -> Result<Option<String>, String> {
    let entry = keyring_entry(app, service_suffix, username)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(err) if is_missing_keyring_entry(&err) => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

fn set_keyring_secret<R: Runtime>(
    app: &AppHandle<R>,
    service_suffix: &str,
    username: &str,
    value: &str,
) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Secret cannot be empty.".to_string());
    }
    let entry = keyring_entry(app, service_suffix, username)?;
    entry.set_password(trimmed).map_err(|e| e.to_string())?;
    Ok(())
}

fn clear_keyring_secret<R: Runtime>(
    app: &AppHandle<R>,
    service_suffix: &str,
    username: &str,
) -> Result<(), String> {
    let entry = keyring_entry(app, service_suffix, username)?;
    if let Err(err) = entry.delete_credential() {
        if !is_missing_keyring_entry(&err) {
            return Err(err.to_string());
        }
    }
    Ok(())
}

pub fn get_github_token<R: Runtime>(app: &AppHandle<R>) -> Result<Option<String>, String> {
    let entry = github_token_entry(app)?;
    match entry.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(err) if is_missing_keyring_entry(&err) => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

pub fn set_github_token<R: Runtime>(app: &AppHandle<R>, token: &str) -> Result<(), String> {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return Err("GitHub token cannot be empty.".to_string());
    }
    let entry = github_token_entry(app)?;
    entry.set_password(trimmed).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn clear_github_token<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let entry = github_token_entry(app)?;
    if let Err(err) = entry.delete_credential() {
        if !is_missing_keyring_entry(&err) {
            return Err(err.to_string());
        }
    }
    Ok(())
}

pub fn get_opencode_image_settings<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<StoredOpencodeImageSettings, String> {
    let Some(raw) = get_setting_value(app, OPENCODE_IMAGE_SETTINGS_KEY)? else {
        return Ok(StoredOpencodeImageSettings::default());
    };

    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

pub fn set_opencode_image_settings<R: Runtime>(
    app: &AppHandle<R>,
    settings: &StoredOpencodeImageSettings,
) -> Result<(), String> {
    if settings.default_provider.is_none()
        && settings.azure_endpoint.is_none()
        && settings.azure_deployment_name.is_none()
    {
        return clear_setting_value(app, OPENCODE_IMAGE_SETTINGS_KEY);
    }

    let raw = serde_json::to_string(settings).map_err(|e| e.to_string())?;
    set_setting_value(app, OPENCODE_IMAGE_SETTINGS_KEY, &raw)
}

pub fn get_opencode_image_openai_api_key<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Option<String>, String> {
    get_keyring_secret(
        app,
        OPENCODE_IMAGE_OPENAI_SERVICE_SUFFIX,
        OPENCODE_IMAGE_API_KEY_USERNAME,
    )
}

pub fn set_opencode_image_openai_api_key<R: Runtime>(
    app: &AppHandle<R>,
    value: &str,
) -> Result<(), String> {
    set_keyring_secret(
        app,
        OPENCODE_IMAGE_OPENAI_SERVICE_SUFFIX,
        OPENCODE_IMAGE_API_KEY_USERNAME,
        value,
    )
}

pub fn clear_opencode_image_openai_api_key<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    clear_keyring_secret(
        app,
        OPENCODE_IMAGE_OPENAI_SERVICE_SUFFIX,
        OPENCODE_IMAGE_API_KEY_USERNAME,
    )
}

pub fn get_opencode_image_azure_api_key<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Option<String>, String> {
    get_keyring_secret(
        app,
        OPENCODE_IMAGE_AZURE_SERVICE_SUFFIX,
        OPENCODE_IMAGE_API_KEY_USERNAME,
    )
}

pub fn set_opencode_image_azure_api_key<R: Runtime>(
    app: &AppHandle<R>,
    value: &str,
) -> Result<(), String> {
    set_keyring_secret(
        app,
        OPENCODE_IMAGE_AZURE_SERVICE_SUFFIX,
        OPENCODE_IMAGE_API_KEY_USERNAME,
        value,
    )
}

pub fn clear_opencode_image_azure_api_key<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    clear_keyring_secret(
        app,
        OPENCODE_IMAGE_AZURE_SERVICE_SUFFIX,
        OPENCODE_IMAGE_API_KEY_USERNAME,
    )
}

pub fn save_repo<R: Runtime>(
    app: &AppHandle<R>,
    name: &str,
    path: &str,
    last_opened: i64,
) -> Result<(), String> {
    Repository::open(path).map_err(|_| "Repository not found".to_string())?;
    let conn = open_db(app)?;
    conn.execute(
        "INSERT INTO repos (path, name, last_opened)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(path) DO UPDATE SET
            name = excluded.name,
            last_opened = excluded.last_opened",
        params![path, name, last_opened],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn remove_repo<R: Runtime>(app: &AppHandle<R>, path: &str) -> Result<(), String> {
    let conn = open_db(app)?;
    conn.execute("DELETE FROM repos WHERE path = ?1", params![path])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn list_repos<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<SavedRepo>, String> {
    let conn = open_db(app)?;
    let mut stmt = conn
        .prepare("SELECT name, path, last_opened FROM repos ORDER BY last_opened DESC")
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(SavedRepo {
                name: row.get(0)?,
                path: row.get(1)?,
                last_opened: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut repos = Vec::new();
    let mut stale_paths = Vec::new();
    for row in rows {
        let repo = row.map_err(|e| e.to_string())?;
        if Repository::open(&repo.path).is_ok() {
            repos.push(repo);
        } else {
            stale_paths.push(repo.path);
        }
    }

    if !stale_paths.is_empty() {
        let mut delete_stmt = conn
            .prepare("DELETE FROM repos WHERE path = ?1")
            .map_err(|e| e.to_string())?;
        for path in stale_paths {
            delete_stmt
                .execute(params![path])
                .map_err(|e| e.to_string())?;
        }
    }

    Ok(repos)
}

pub fn reset_storage<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let conn = open_db(app)?;
    conn.execute("DELETE FROM repos", [])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM settings", [])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM containers", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn upsert_container<R: Runtime>(
    app: &AppHandle<R>,
    container: &StoredContainer,
) -> Result<(), String> {
    let conn = open_db(app)?;
    conn.execute(
        "INSERT INTO containers (id, repo_path, app_id, name, vm, image, created_at, last_used)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
            repo_path = excluded.repo_path,
            app_id = excluded.app_id,
            name = excluded.name,
            vm = excluded.vm,
            image = excluded.image,
            last_used = excluded.last_used",
        params![
            container.id,
            container.repo_path,
            container.app_id,
            container.name,
            container.vm,
            container.image,
            container.created_at,
            container.last_used
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn list_containers<R: Runtime>(
    app: &AppHandle<R>,
    repo_path: Option<&str>,
) -> Result<Vec<StoredContainer>, String> {
    let conn = open_db(app)?;
    let mut containers = Vec::new();
    if let Some(repo_path) = repo_path {
        let mut stmt = conn
            .prepare(
                "SELECT id, repo_path, app_id, name, vm, image, created_at, last_used
                 FROM containers
                 WHERE repo_path = ?1
                 ORDER BY last_used DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![repo_path], |row| {
                Ok(StoredContainer {
                    id: row.get(0)?,
                    repo_path: row.get(1)?,
                    app_id: row.get(2)?,
                    name: row.get(3)?,
                    vm: row.get(4)?,
                    image: row.get(5)?,
                    created_at: row.get(6)?,
                    last_used: row.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            containers.push(row.map_err(|e| e.to_string())?);
        }
    } else {
        let mut stmt = conn
            .prepare(
                "SELECT id, repo_path, app_id, name, vm, image, created_at, last_used
                 FROM containers
                 ORDER BY last_used DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(StoredContainer {
                    id: row.get(0)?,
                    repo_path: row.get(1)?,
                    app_id: row.get(2)?,
                    name: row.get(3)?,
                    vm: row.get(4)?,
                    image: row.get(5)?,
                    created_at: row.get(6)?,
                    last_used: row.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            containers.push(row.map_err(|e| e.to_string())?);
        }
    }
    Ok(containers)
}

pub fn remove_container<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<(), String> {
    let conn = open_db(app)?;
    conn.execute("DELETE FROM containers WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
