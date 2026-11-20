//! Fork (relay provider): native transport for the author's OpenAI-compatible
//! relay endpoint (中转站).
//!
//! Relay gateways commonly answer CORS preflights with 401 and send no
//! `Access-Control-Allow-*` headers, so a WebView fetch carrying
//! `Authorization` is blocked before it leaves the renderer. All relay HTTP
//! therefore goes through this native host, following the OpenAI Responses
//! transport's contract: the renderer supplies the base URL and the bounded
//! JSON body only; the API key is read from `byok.relay` here and never
//! crosses IPC.
//!
//! Boundaries: https only (http is allowed for loopback development servers),
//! no redirects, no URL credentials, bounded request/error/response bytes,
//! cancellable per request id, upstream error text truncated and sanitized.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use futures_util::future::{AbortHandle, Abortable};
use futures_util::StreamExt;
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, AppHandle, State};

use crate::secure_storage;

const RELAY_KEY_ID: &str = "byok.relay";
const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
const MAX_ERROR_BYTES: usize = 64 * 1024;
const MAX_PRE_CANCELLED: usize = 1024;
const MODELS_TIMEOUT_MS: u64 = 20_000;
const MAX_MODELS_BYTES: usize = 4 * 1024 * 1024;
const MAX_MODELS: usize = 500;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayChatRequestInput {
    request_id: String,
    base_url: String,
    body: String,
    timeout_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RelayStreamEvent {
    Started {
        status: u16,
        /// The upstream response's content type, so the SDK parses JSON
        /// (non-streaming calls) and SSE (streaming calls) correctly.
        #[serde(rename = "contentType")]
        content_type: Option<String>,
        #[serde(rename = "errorCode")]
        error_code: Option<String>,
        #[serde(rename = "errorMessage")]
        error_message: Option<String>,
    },
    Chunk {
        bytes: Vec<u8>,
    },
    Finished,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayModelEntry {
    id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayModelListResponse {
    models: Vec<RelayModelEntry>,
}

#[derive(Default)]
struct RelayPending {
    requests: HashMap<String, AbortHandle>,
    pre_cancelled: HashSet<String>,
}

#[derive(Default)]
pub struct RelayApiState {
    pending: Mutex<RelayPending>,
    client: OnceLock<reqwest::Client>,
}

impl RelayApiState {
    fn client(&self) -> Result<reqwest::Client, String> {
        if let Some(client) = self.client.get() {
            return Ok(client.clone());
        }
        let client = reqwest::Client::builder()
            .https_only(false)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "RELAY_TRANSPORT_UNAVAILABLE: could not build the relay client")?;
        let _ = self.client.set(client.clone());
        Ok(self
            .client
            .get()
            .cloned()
            .unwrap_or_else(|| client))
    }
}

/// A relay base URL: https anywhere, or http only on the loopback interface.
fn validated_origin(base_url: &str) -> Result<reqwest::Url, String> {
    let trimmed = base_url.trim();
    if trimmed.is_empty() || trimmed.len() > 500 {
        return Err("RELAY_INVALID_URL: the relay base URL is empty or too long".into());
    }
    let url = reqwest::Url::parse(trimmed)
        .map_err(|_| "RELAY_INVALID_URL: the relay base URL is not a valid URL".to_string())?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("RELAY_INVALID_URL: the relay base URL must not carry credentials".into());
    }
    let loopback = matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    let scheme_ok = url.scheme() == "https" || (url.scheme() == "http" && loopback);
    if !scheme_ok || url.host_str().is_none() {
        return Err(
            "RELAY_INVALID_URL: the relay base URL must be https (http only for loopback)".into(),
        );
    }
    Ok(url)
}

/// `{base}/{path}` with exactly one separating slash.
fn endpoint(base_url: &str, path: &str) -> Result<reqwest::Url, String> {
    let mut url = validated_origin(base_url)?;
    let base_path = url.path().trim_end_matches('/').to_string();
    url.set_path(&format!("{base_path}/{path}"));
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn validate_input(input: &RelayChatRequestInput) -> Result<(), String> {
    if input.request_id.is_empty()
        || input.request_id.len() > 200
        || !input
            .request_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("RELAY_INVALID_REQUEST: request id is malformed".into());
    }
    if input.body.len() > MAX_REQUEST_BYTES {
        return Err("RELAY_INVALID_REQUEST: the request body is too large".into());
    }
    if !(1_000..=600_000).contains(&input.timeout_ms) {
        return Err("RELAY_INVALID_REQUEST: timeout is out of range".into());
    }
    endpoint(&input.base_url, "chat/completions")?;
    Ok(())
}

async fn read_relay_key(app: &AppHandle) -> Result<String, String> {
    let key_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || secure_storage::read_secret(&key_app, RELAY_KEY_ID))
        .await
        .map_err(|_| "RELAY_CREDENTIAL_UNAVAILABLE: secure storage worker failed")?
        .map_err(|_| "RELAY_CREDENTIAL_UNAVAILABLE: relay key could not be read")?
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "RELAY_CREDENTIAL_MISSING: no relay API key is configured".to_string())
}

#[tauri::command]
pub async fn relay_models_list(
    app: AppHandle,
    state: State<'_, RelayApiState>,
    base_url: String,
) -> Result<RelayModelListResponse, String> {
    let url = endpoint(&base_url, "models")?;
    let client = state.client()?;
    let api_key = read_relay_key(&app).await?;
    let response = client
        .get(url)
        .header(ACCEPT, "application/json")
        .bearer_auth(api_key)
        .timeout(Duration::from_millis(MODELS_TIMEOUT_MS))
        .send()
        .await
        .map_err(project_network_error)?;
    let status = response.status();
    if !status.is_success() {
        let body = read_bounded(response, MAX_ERROR_BYTES).await?;
        return Err(project_upstream_error(status.as_u16(), &body));
    }
    let body = read_bounded(response, MAX_MODELS_BYTES).await?;
    Ok(project_models(&body))
}

#[tauri::command]
pub async fn relay_chat_stream(
    app: AppHandle,
    state: State<'_, RelayApiState>,
    input: RelayChatRequestInput,
    on_event: Channel<RelayStreamEvent>,
) -> Result<(), String> {
    validate_input(&input)?;
    let client = state.client()?;
    let (abort, registration) = AbortHandle::new_pair();
    {
        let mut pending = state
            .pending
            .lock()
            .map_err(|_| "RELAY_TRANSPORT_UNAVAILABLE: request state is unavailable")?;
        if pending.pre_cancelled.remove(&input.request_id) {
            return Err("RELAY_REQUEST_CANCELLED: request was cancelled".into());
        }
        if pending
            .requests
            .insert(input.request_id.clone(), abort)
            .is_some()
        {
            return Err("RELAY_INVALID_REQUEST: request id is already active".into());
        }
    }

    let request_id = input.request_id.clone();
    let result = Abortable::new(execute(app, client, input, on_event), registration).await;
    if let Ok(mut pending) = state.pending.lock() {
        pending.requests.remove(&request_id);
        pending.pre_cancelled.remove(&request_id);
    }
    match result {
        Ok(result) => result,
        Err(_) => Err("RELAY_REQUEST_CANCELLED: request was cancelled".into()),
    }
}

#[tauri::command]
pub fn relay_chat_cancel(
    state: State<'_, RelayApiState>,
    request_id: String,
) -> Result<bool, String> {
    if request_id.is_empty() || request_id.len() > 200 {
        return Err("RELAY_INVALID_REQUEST: request id is malformed".into());
    }
    let mut pending = state
        .pending
        .lock()
        .map_err(|_| "RELAY_TRANSPORT_UNAVAILABLE: request state is unavailable")?;
    if let Some(handle) = pending.requests.remove(&request_id) {
        handle.abort();
        return Ok(true);
    }
    if pending.pre_cancelled.len() >= MAX_PRE_CANCELLED {
        return Err("RELAY_TRANSPORT_UNAVAILABLE: cancellation queue is full".into());
    }
    Ok(pending.pre_cancelled.insert(request_id))
}

async fn execute(
    app: AppHandle,
    client: reqwest::Client,
    input: RelayChatRequestInput,
    on_event: Channel<RelayStreamEvent>,
) -> Result<(), String> {
    let url = endpoint(&input.base_url, "chat/completions")?;
    let api_key = read_relay_key(&app).await?;
    let response = client
        .post(url)
        .header(ACCEPT, "text/event-stream")
        .header(CONTENT_TYPE, "application/json")
        .bearer_auth(api_key)
        .timeout(Duration::from_millis(input.timeout_ms))
        .body(input.body)
        .send()
        .await
        .map_err(project_network_error)?;

    let status = response.status();
    if !status.is_success() {
        let body = read_bounded(response, MAX_ERROR_BYTES).await?;
        let message = project_upstream_error(status.as_u16(), &body);
        send_event(
            &on_event,
            RelayStreamEvent::Started {
                status: status.as_u16(),
                content_type: None,
                error_code: Some(format!("RELAY_HTTP_{}", status.as_u16())),
                error_message: Some(message),
            },
        )?;
        send_event(&on_event, RelayStreamEvent::Finished)?;
        return Ok(());
    }

    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    send_event(
        &on_event,
        RelayStreamEvent::Started {
            status: status.as_u16(),
            content_type,
            error_code: None,
            error_message: None,
        },
    )?;

    let mut total = 0_usize;
    let mut stream = response.bytes_stream();
    while let Some(next) = stream.next().await {
        let chunk = next.map_err(|_| {
            "RELAY_STREAM_FAILED: the relay response stream could not be read".to_string()
        })?;
        total = total.saturating_add(chunk.len());
        if total > MAX_RESPONSE_BYTES {
            return Err("RELAY_STREAM_TOO_LARGE: the relay response exceeded the size limit".into());
        }
        send_event(
            &on_event,
            RelayStreamEvent::Chunk {
                bytes: chunk.to_vec(),
            },
        )?;
    }
    send_event(&on_event, RelayStreamEvent::Finished)
}

fn send_event(channel: &Channel<RelayStreamEvent>, event: RelayStreamEvent) -> Result<(), String> {
    channel
        .send(event)
        .map_err(|_| "RELAY_STREAM_CLOSED: renderer stream is unavailable".into())
}

async fn read_bounded(response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(next) = stream.next().await {
        let chunk = next.map_err(|_| "RELAY_STREAM_FAILED: the relay response could not be read")?;
        if bytes.len().saturating_add(chunk.len()) > limit {
            break;
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn project_network_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "RELAY_NETWORK_ERROR: the relay did not answer in time".into()
    } else if error.is_connect() {
        "RELAY_NETWORK_ERROR: the relay could not be reached".into()
    } else {
        "RELAY_NETWORK_ERROR: the relay request failed".into()
    }
}

/// Upstream relay error text, truncated to one sanitized line. The API key is
/// never part of this string; upstream bodies are bounded before parsing.
fn project_upstream_error(status: u16, body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body);
    let compact = text
        .replace(['\r', '\n', '\t'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let excerpt: String = compact.chars().take(300).collect();
    if excerpt.is_empty() {
        format!("RELAY_UPSTREAM_ERROR: the relay answered HTTP {status}")
    } else {
        format!("RELAY_UPSTREAM_ERROR: the relay answered HTTP {status}: {excerpt}")
    }
}

/// Accepts the OpenAI `{ "data": [{ "id": ... }] }` shape and the common
/// gateway variant `{ "models": ["id", ...] }`; anything else yields empty.
fn project_models(body: &[u8]) -> RelayModelListResponse {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(body) else {
        return RelayModelListResponse { models: Vec::new() };
    };
    let mut ids: Vec<String> = Vec::new();
    let mut push = |id: Option<&str>| {
        if let Some(id) = id {
            let id = id.trim();
            if !id.is_empty() && id.len() <= 200 && !ids.iter().any(|known| known == id) {
                ids.push(id.to_string());
            }
        }
    };
    if let Some(entries) = value.get("data").and_then(serde_json::Value::as_array) {
        for entry in entries {
            push(entry.get("id").and_then(serde_json::Value::as_str));
        }
    } else if let Some(entries) = value.get("models").and_then(serde_json::Value::as_array) {
        for entry in entries {
            push(entry.as_str());
        }
    }
    ids.truncate(MAX_MODELS);
    RelayModelListResponse {
        models: ids
            .into_iter()
            .map(|id| RelayModelEntry { id })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_https_and_loopback_http_only() {
        assert!(validated_origin("https://relay.example.com/v1").is_ok());
        assert!(validated_origin("http://127.0.0.1:8080/v1").is_ok());
        assert!(validated_origin("http://localhost:3000/v1").is_ok());
        assert!(validated_origin("http://relay.example.com/v1").is_err());
        assert!(validated_origin("ftp://relay.example.com/v1").is_err());
        assert!(validated_origin("").is_err());
        assert!(validated_origin("https://user:pass@relay.example.com/v1").is_err());
    }

    #[test]
    fn joins_endpoint_paths_with_one_slash() {
        assert_eq!(
            endpoint("https://relay.example.com/v1", "models").unwrap().as_str(),
            "https://relay.example.com/v1/models"
        );
        assert_eq!(
            endpoint("https://relay.example.com/v1/", "models").unwrap().as_str(),
            "https://relay.example.com/v1/models"
        );
        assert_eq!(
            endpoint("https://relay.example.com", "chat/completions")
                .unwrap()
                .as_str(),
            "https://relay.example.com/chat/completions"
        );
    }

    #[test]
    fn projects_openai_and_gateway_model_shapes() {
        let standard = project_models(
            br#"{"data":[{"id":"gpt-4o"},{"id":"claude-3.5-sonnet"},{"id":"gpt-4o"}]}"#,
        );
        assert_eq!(
            standard.models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["gpt-4o", "claude-3.5-sonnet"]
        );
        let gateway = project_models(br#"{"models":["deepseek-chat","qwen-max"]}"#);
        assert_eq!(
            gateway.models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["deepseek-chat", "qwen-max"]
        );
        assert!(project_models(b"not json").models.is_empty());
        assert!(project_models(b"{}").models.is_empty());
    }

    #[test]
    fn sanitizes_upstream_errors() {
        let message = project_upstream_error(401, b"{\"error\":{\"message\":\"bad key\\nline\"}}");
        assert!(message.starts_with("RELAY_UPSTREAM_ERROR: the relay answered HTTP 401"));
        assert!(!message.contains('\n'));
        assert!(message.len() <= 400);
        let empty = project_upstream_error(502, b"");
        assert_eq!(
            empty,
            "RELAY_UPSTREAM_ERROR: the relay answered HTTP 502"
        );
    }

    #[test]
    fn rejects_oversized_or_malformed_requests() {
        let mut input = RelayChatRequestInput {
            request_id: "relay-ok_1".into(),
            base_url: "https://relay.example.com/v1".into(),
            body: "{}".into(),
            timeout_ms: 30_000,
        };
        assert!(validate_input(&input).is_ok());
        input.request_id = "bad id!".into();
        assert!(validate_input(&input).is_err());
        input.request_id = "relay-ok_1".into();
        input.base_url = "http://relay.example.com/v1".into();
        assert!(validate_input(&input).is_err());
        input.base_url = "https://relay.example.com/v1".into();
        input.timeout_ms = 10;
        assert!(validate_input(&input).is_err());
        input.timeout_ms = 30_000;
        input.body = "x".repeat(MAX_REQUEST_BYTES + 1);
        assert!(validate_input(&input).is_err());
    }
}
