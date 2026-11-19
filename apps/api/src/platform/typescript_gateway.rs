//! FORA DO CAMINHO DE PRODUÇÃO (PR 02): o `api-ts` é a API principal e nenhuma imagem, compose ou
//! release inicia o binário Rust. Mantido só como referência de leitura até a remoção no PR 11.
//! Transport for the four migrated modules. No business rules or command retry.
use std::time::Duration;

use anyhow::{Context, ensure};
use axum::{
    Json,
    body::{Body, to_bytes},
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::{Client, Url};

use super::state::AppState;

const REQUEST_HEADERS: &[&str] = &[
    "x-tenant-id",
    "if-match",
    "idempotency-key",
    "content-type",
    "accept",
    "x-request-id",
];
const RESPONSE_HEADERS: &[&str] = &[
    "content-type",
    "cache-control",
    "etag",
    "retry-after",
    "content-disposition",
    "location",
    "x-request-id",
    "x-erp-backend",
    "idempotency-replayed",
    "www-authenticate",
];

/// An internal capability inserted after native MCP OAuth validation. Incoming
/// HTTP headers cannot create this request extension. Never log its contents.
#[derive(Clone)]
pub struct McpDispatchCredential(String);
impl McpDispatchCredential {
    pub(crate) fn validated(authorization: &str) -> Self {
        Self(authorization.to_owned())
    }
}

#[derive(Clone, Debug)]
pub struct TypescriptGateway {
    origin: Url,
    http: Client,
}

impl TypescriptGateway {
    pub fn new(origin: &str) -> anyhow::Result<Self> {
        let origin = Url::parse(origin).context("ERP_TYPESCRIPT_API_URL must be an origin")?;
        ensure!(
            origin.username().is_empty()
                && origin.password().is_none()
                && origin.path() == "/"
                && origin.query().is_none()
                && origin.fragment().is_none(),
            "ERP_TYPESCRIPT_API_URL must be a bare origin"
        );
        ensure!(
            origin.scheme() == "https"
                || origin.scheme() == "http"
                    && matches!(origin.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")),
            "ERP_TYPESCRIPT_API_URL requires HTTPS or HTTP loopback"
        );
        let http = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(110))
            .build()?;
        Ok(Self { origin, http })
    }

    pub(crate) async fn forward(&self, request: Request) -> Response {
        let (parts, body) = request.into_parts();
        let request_id = parts.headers.get("x-request-id").cloned();
        let fail = |status, code| {
            let mut response = problem(status, code);
            if let Some(value) = request_id.clone() {
                response.headers_mut().insert("x-request-id", value);
            }
            response
        };
        let path = parts
            .uri
            .path_and_query()
            .map(|value| value.as_str())
            .unwrap_or("");
        if !path.starts_with("/api/v1/") {
            return fail(StatusCode::BAD_REQUEST, "invalid_resource");
        }
        let bytes = match to_bytes(body, 2_097_152).await {
            Ok(bytes) => bytes,
            Err(_) => return fail(StatusCode::PAYLOAD_TOO_LARGE, "body_too_large"),
        };
        let mut headers = HeaderMap::new();
        for &name in REQUEST_HEADERS {
            for value in parts.headers.get_all(name) {
                headers.append(name, value.clone());
            }
        }
        let builder = if let Some(credential) = parts.extensions.get::<McpDispatchCredential>() {
            let encoded: serde_json::Map<String, serde_json::Value> = headers
                .iter()
                .filter_map(|(name, value)| {
                    value
                        .to_str()
                        .ok()
                        .map(|value| (name.to_string(), value.into()))
                })
                .collect();
            self.http.post(self.origin.join("internal/mcp/dispatch").expect("fixed path"))
                .header("authorization", &credential.0)
                .json(&serde_json::json!({"method":parts.method.as_str(), "resource":path, "headers":encoded, "body":STANDARD.encode(&bytes)}))
        } else {
            if let Some(value) = parts.headers.get("authorization") {
                headers.insert("authorization", value.clone());
            }
            let mut url = self.origin.clone();
            url.set_path(parts.uri.path());
            url.set_query(parts.uri.query());
            self.http
                .request(parts.method, url)
                .headers(headers)
                .body(bytes)
        };
        // A timeout/error can follow a committed mutation. Surface uncertainty;
        // never resend, redirect, or switch to the reference implementation.
        let mut upstream = match builder.send().await {
            Ok(response) => response,
            Err(error) => {
                return fail(
                    if error.is_timeout() {
                        StatusCode::GATEWAY_TIMEOUT
                    } else {
                        StatusCode::BAD_GATEWAY
                    },
                    "operation_outcome_uncertain",
                );
            }
        };
        let status = upstream.status();
        let mut response_headers = HeaderMap::new();
        for &name in RESPONSE_HEADERS {
            if let Some(value) = upstream.headers().get(name) {
                response_headers.insert(name, value.clone());
            }
        }
        let mut output = Vec::new();
        loop {
            match upstream.chunk().await {
                Ok(Some(chunk)) if output.len() + chunk.len() <= 32 * 1024 * 1024 => {
                    output.extend_from_slice(&chunk)
                }
                Ok(None) => break,
                _ => return fail(StatusCode::BAD_GATEWAY, "response_unavailable_or_too_large"),
            }
        }
        let mut response = Response::new(Body::from(output));
        *response.status_mut() = status;
        *response.headers_mut() = response_headers;
        response
    }
}

fn problem(status: StatusCode, code: &str) -> Response {
    (status, [("content-type", "application/problem+json"), ("cache-control", "no-store")], Json(serde_json::json!({"type":format!("https://erp.avilaops.com/problems/{code}"), "title":"Operação temporariamente indisponível", "status":status.as_u16()}))).into_response()
}

pub async fn dispatch(State(state): State<AppState>, request: Request) -> Response {
    match state.typescript.as_ref() {
        Some(gateway) => gateway.forward(request).await,
        None => problem(StatusCode::SERVICE_UNAVAILABLE, "typescript_unavailable"),
    }
}
