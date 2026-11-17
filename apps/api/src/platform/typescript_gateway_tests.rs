use super::typescript_gateway::{McpDispatchCredential, TypescriptGateway};
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::Request,
    http::StatusCode,
    response::IntoResponse,
    routing::any,
};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

#[tokio::test]
async fn missing_gateway_fails_before_any_business_or_auth_call() {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://postgres@127.0.0.1:1/test")
        .unwrap();
    let state = crate::platform::state::AppState::new(
        pool,
        crate::platform::auth::AuthClient::new("http://127.0.0.1:1/userinfo".into()),
    );
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/orders")
        .body(Body::from("{}"))
        .unwrap();
    let response = super::typescript_gateway::dispatch(axum::extract::State(state), request).await;
    assert_eq!(response.status(), 503);
    assert!(
        String::from_utf8(to_bytes(response.into_body(), 4096).await.unwrap().to_vec())
            .unwrap()
            .contains("typescript_unavailable")
    );
}

#[test]
fn gateway_only_accepts_a_bare_trusted_origin() {
    for origin in [
        "http://outside.test",
        "https://user:pass@example.test",
        "https://example.test/path",
        "https://example.test?x=1",
        "https://example.test#part",
    ] {
        assert!(TypescriptGateway::new(origin).is_err(), "{origin}");
    }
    assert!(TypescriptGateway::new("http://127.0.0.1:8081").is_ok());
    assert!(TypescriptGateway::new("https://private.example.test").is_ok());
}

#[tokio::test]
async fn gateway_preserves_wire_bytes_headers_and_mcp_credential_without_retry() {
    let received = Arc::new(Mutex::new(Vec::new()));
    let capture = received.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().fallback(any(move |request: Request| {
                let capture = capture.clone();
                async move {
                    let (parts, body) = request.into_parts();
                    let bytes = to_bytes(body, 3_000_000).await.unwrap();
                    capture
                        .lock()
                        .unwrap()
                        .push((parts.uri.to_string(), parts.headers, bytes));
                    (
                        StatusCode::CONFLICT,
                        [
                            ("etag", "\"9007199254740993\""),
                            ("x-erp-backend", "typescript"),
                            ("x-request-id", "gateway-request"),
                        ],
                        "{\"revision\":9007199254740993}",
                    )
                        .into_response()
                }
            })),
        )
        .await
        .unwrap()
    });
    let gateway = TypescriptGateway::new(&origin).unwrap();
    let input = "{\"revision\":9007199254740993}";
    let request = Request::builder()
        .method("PUT")
        .uri("/api/v1/preferences?name=a%20b")
        .header("authorization", "Bearer auth-fixture")
        .header("x-tenant-id", "tenant")
        .header("if-match", "\"9007199254740993\"")
        .header("x-request-id", "gateway-request")
        .header("content-type", "application/json")
        .header("cookie", "must-not-forward")
        .body(Body::from(input))
        .unwrap();
    let response = gateway.forward(request).await;
    assert_eq!(response.status(), 409);
    assert_eq!(response.headers()["etag"], "\"9007199254740993\"");
    assert_eq!(to_bytes(response.into_body(), 1024).await.unwrap(), input);
    let mut request = Request::builder()
        .method("PUT")
        .uri("/api/v1/preferences")
        .header("if-match", "\"7\"")
        .header("content-type", "application/json")
        .body(Body::from(input))
        .unwrap();
    request
        .extensions_mut()
        .insert(McpDispatchCredential::validated("Bearer mcp_at_fixture"));
    assert_eq!(gateway.forward(request).await.status(), 409);
    tokio::time::sleep(Duration::from_millis(30)).await;
    let calls = received.lock().unwrap();
    assert_eq!(
        calls.len(),
        2,
        "exactly one send for each request, including 409"
    );
    assert_eq!(calls[0].0, "/api/v1/preferences?name=a%20b");
    assert_eq!(calls[0].1["authorization"], "Bearer auth-fixture");
    assert!(!calls[0].1.contains_key("cookie"));
    assert_eq!(calls[0].2, input);
    assert_eq!(calls[1].0, "/internal/mcp/dispatch");
    assert_eq!(calls[1].1["authorization"], "Bearer mcp_at_fixture");
    let envelope: serde_json::Value = serde_json::from_slice(&calls[1].2).unwrap();
    assert_eq!(envelope["resource"], "/api/v1/preferences");
    assert_eq!(envelope["headers"]["if-match"], "\"7\"");
    assert!(envelope["headers"].get("authorization").is_none());
    use base64::Engine;
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(envelope["body"].as_str().unwrap())
            .unwrap(),
        input.as_bytes()
    );
    server.abort();
}
