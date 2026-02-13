use reqwest::{header, Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, State};
use tokio::time::{sleep, Duration, Instant};

use crate::storage;

const DEVICE_URL: &str = "https://github.com/login/device/code";
const TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const API_BASE: &str = "https://api.github.com";
const DEFAULT_SCOPE: &str = "repo write:public_key";
const USER_AGENT: &str = "Falck";
const GITHUB_API_VERSION: &str = "2022-11-28";

#[derive(Debug, Serialize, Deserialize)]
pub struct DeviceCodeResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: Option<String>,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TokenInfo {
    pub token_type: String,
    pub scope: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GithubUser {
    pub login: String,
    pub id: u64,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GithubOwner {
    pub login: String,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GithubRepo {
    pub id: u64,
    pub name: String,
    pub full_name: String,
    pub private: bool,
    pub html_url: String,
    pub ssh_url: String,
    pub clone_url: String,
    pub default_branch: Option<String>,
    pub updated_at: Option<String>,
    pub fork: bool,
    pub archived: bool,
    pub disabled: bool,
    pub owner: GithubOwner,
}

fn github_client_id() -> Result<String, String> {
    std::env::var("GITHUB_CLIENT_ID")
        .or_else(|_| std::env::var("FALCK_GITHUB_CLIENT_ID"))
        .map_err(|_| "Missing GitHub OAuth client id. Set GITHUB_CLIENT_ID.".to_string())
}

fn store_token(app: &AppHandle, token: &str) -> Result<(), String> {
    storage::set_github_token(app, token)
}

fn load_token(app: &AppHandle) -> Result<String, String> {
    storage::get_github_token(app)?
        .ok_or_else(|| "GitHub token not found. Connect GitHub first.".to_string())
}

fn has_token(app: &AppHandle) -> Result<bool, String> {
    Ok(storage::get_github_token(app)?.is_some())
}

fn clear_token(app: &AppHandle) -> Result<(), String> {
    storage::clear_github_token(app)
}

fn build_api_headers(token: &str) -> header::HeaderMap {
    let mut headers = header::HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        header::HeaderValue::from_str(&format!("Bearer {}", token)).unwrap(),
    );
    headers.insert(
        header::ACCEPT,
        header::HeaderValue::from_static("application/vnd.github+json"),
    );
    headers.insert(
        header::USER_AGENT,
        header::HeaderValue::from_static(USER_AGENT),
    );
    headers.insert(
        "X-GitHub-Api-Version",
        header::HeaderValue::from_static(GITHUB_API_VERSION),
    );
    headers
}

fn parse_next_link(link_header: &str) -> Option<String> {
    for part in link_header.split(',') {
        let section = part.trim();
        let mut pieces = section.split(';');
        let url_part = pieces.next()?.trim();
        let rel_part = pieces.find(|piece| piece.trim() == "rel=\"next\"");
        if rel_part.is_some() {
            let trimmed = url_part.trim_start_matches('<').trim_end_matches('>');
            return Some(trimmed.to_string());
        }
    }
    None
}

#[tauri::command]
pub async fn github_start_device_flow(
    client: State<'_, Client>,
    scope: Option<String>,
) -> Result<DeviceCodeResponse, String> {
    let client_id = github_client_id()?;
    let scope = scope
        .and_then(|s| {
            let trimmed = s.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        })
        .unwrap_or_else(|| DEFAULT_SCOPE.to_string());

    let params = [("client_id", client_id), ("scope", scope)];
    let response = client
        .post(DEVICE_URL)
        .header(header::ACCEPT, "application/json")
        .header(header::USER_AGENT, USER_AGENT)
        .form(&params)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("GitHub device flow failed: {}", body));
    }

    response
        .json::<DeviceCodeResponse>()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn github_poll_device_token(
    app: AppHandle,
    client: State<'_, Client>,
    device_code: String,
    interval: u64,
    expires_in: u64,
) -> Result<TokenInfo, String> {
    let client_id = github_client_id()?;
    let start_time = Instant::now();
    let mut wait_seconds = interval.max(1);

    loop {
        if start_time.elapsed().as_secs() >= expires_in {
            return Err("Device code expired. Start the login again.".to_string());
        }

        sleep(Duration::from_secs(wait_seconds)).await;

        let params = [
            ("client_id", client_id.clone()),
            ("device_code", device_code.clone()),
            (
                "grant_type",
                "urn:ietf:params:oauth:grant-type:device_code".to_string(),
            ),
        ];

        let response = client
            .post(TOKEN_URL)
            .header(header::ACCEPT, "application/json")
            .header(header::USER_AGENT, USER_AGENT)
            .form(&params)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        let payload = response
            .json::<serde_json::Value>()
            .await
            .map_err(|e| e.to_string())?;

        if let Some(access_token) = payload.get("access_token").and_then(|v| v.as_str()) {
            let token_type = payload
                .get("token_type")
                .and_then(|v| v.as_str())
                .unwrap_or("bearer");
            let scope = payload.get("scope").and_then(|v| v.as_str()).unwrap_or("");

            store_token(&app, access_token)?;
            return Ok(TokenInfo {
                token_type: token_type.to_string(),
                scope: scope.to_string(),
            });
        }

        if let Some(error) = payload.get("error").and_then(|v| v.as_str()) {
            match error {
                "authorization_pending" => continue,
                "slow_down" => {
                    wait_seconds += 5;
                    continue;
                }
                "access_denied" => {
                    return Err("GitHub authorization was denied.".to_string());
                }
                "expired_token" => {
                    return Err("Device code expired. Start the login again.".to_string());
                }
                _ => {
                    return Err(format!("GitHub OAuth error: {}", error));
                }
            }
        }

        return Err("Unexpected GitHub OAuth response.".to_string());
    }
}

#[tauri::command]
pub async fn github_has_token(app: AppHandle) -> Result<bool, String> {
    has_token(&app)
}

#[tauri::command]
pub async fn github_clear_token(app: AppHandle) -> Result<(), String> {
    clear_token(&app)
}

#[tauri::command]
pub async fn github_get_user(
    app: AppHandle,
    client: State<'_, Client>,
) -> Result<GithubUser, String> {
    let token = load_token(&app)?;
    let response = client
        .get(format!("{}/user", API_BASE))
        .headers(build_api_headers(&token))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if response.status() == StatusCode::UNAUTHORIZED {
        return Err("GitHub token is invalid or expired.".to_string());
    }

    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("GitHub user fetch failed: {}", body));
    }

    response
        .json::<GithubUser>()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn github_list_repos(
    app: AppHandle,
    client: State<'_, Client>,
) -> Result<Vec<GithubRepo>, String> {
    let token = load_token(&app)?;
    let mut url = format!(
        "{}/user/repos?per_page=100&sort=updated&direction=desc&affiliation=owner,collaborator,organization_member",
        API_BASE
    );
    let mut repos = Vec::new();

    loop {
        let response = client
            .get(&url)
            .headers(build_api_headers(&token))
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if response.status() == StatusCode::UNAUTHORIZED {
            return Err("GitHub token is invalid or expired.".to_string());
        }

        if !response.status().is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(format!("GitHub repo fetch failed: {}", body));
        }

        let headers = response.headers().clone();
        let mut page = response
            .json::<Vec<GithubRepo>>()
            .await
            .map_err(|e| e.to_string())?;
        repos.append(&mut page);

        let next = headers
            .get(header::LINK)
            .and_then(|value| value.to_str().ok())
            .and_then(parse_next_link);
        if let Some(next_url) = next {
            url = next_url;
        } else {
            break;
        }
    }

    Ok(repos)
}

pub async fn github_create_repo(
    app: AppHandle,
    client: &Client,
    name: String,
    description: Option<String>,
    private: bool,
) -> Result<GithubRepo, String> {
    if name.trim().is_empty() {
        return Err("Repository name is required.".to_string());
    }

    let token = load_token(&app)?;
    let response = client
        .post(format!("{}/user/repos", API_BASE))
        .headers(build_api_headers(&token))
        .json(&json!({
            "name": name.trim(),
            "description": description,
            "private": private,
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if response.status() == StatusCode::UNAUTHORIZED {
        return Err("GitHub token is invalid or expired.".to_string());
    }

    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("GitHub repo create failed: {}", body));
    }

    response
        .json::<GithubRepo>()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn github_add_ssh_key(
    app: AppHandle,
    client: State<'_, Client>,
    title: String,
    key: String,
) -> Result<(), String> {
    let token = load_token(&app)?;
    if title.trim().is_empty() {
        return Err("Key title is required.".to_string());
    }
    if key.trim().is_empty() {
        return Err("SSH public key is required.".to_string());
    }

    let response = client
        .post(format!("{}/user/keys", API_BASE))
        .headers(build_api_headers(&token))
        .json(&json!({ "title": title.trim(), "key": key.trim() }))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if response.status().is_success() {
        return Ok(());
    }

    if response.status() == StatusCode::UNPROCESSABLE_ENTITY {
        let payload = response
            .json::<serde_json::Value>()
            .await
            .unwrap_or_default();
        let message = payload
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("SSH key already exists on GitHub.");
        return Err(message.to_string());
    }

    let body = response.text().await.unwrap_or_default();
    Err(format!("GitHub SSH key upload failed: {}", body))
}
