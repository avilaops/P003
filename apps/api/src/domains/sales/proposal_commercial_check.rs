//! Native delivery asks the TypeScript owner to validate the commercial agreement.
//! The caller holds the tenant write lock; this read never acquires that lock.
use axum::{
    body::{Body, to_bytes},
    extract::State,
    http::{HeaderMap, Request, StatusCode},
    response::Response,
};
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    domains::{DomainError, db, response},
    platform::{state::AppState, typescript_gateway::McpDispatchCredential},
};

#[derive(serde::Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProposalCommercialValidation {
    tenant_id: Uuid,
    revision: i64,
    approval_candidate: Option<Value>,
}

#[utoipa::path(post,path="/api/v1/proposals/{id}/commercial-validation",tag="Sales",security(("bearerAuth"=[])),params(("id"=Uuid,Path),("X-Tenant-Id"=Uuid,Header)),responses((status=200,body=ProposalCommercialValidation),(status=409,description="Proposta exige revisão ou aprovação"),(status=503,description="Validação comercial indisponível")))]
pub async fn validate(State(state): State<AppState>, request: axum::extract::Request) -> Response {
    crate::platform::typescript_gateway::dispatch(State(state), request).await
}

pub(super) async fn required(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    proposal: Uuid,
    version: i32,
) -> Result<bool, DomainError> {
    sqlx::query_scalar("SELECT commercial_public IS NOT NULL OR EXISTS(SELECT 1 FROM sales_proposal_lines l JOIN price_table_items i ON i.tenant_id=l.tenant_id AND i.product_id=l.product_id JOIN commercial_settings s ON s.tenant_id=i.tenant_id AND s.active_price_version_id=i.version_id WHERE l.tenant_id=v.tenant_id AND l.proposal_id=v.proposal_id AND l.version=v.version) FROM sales_proposal_versions v WHERE tenant_id=$1 AND proposal_id=$2 AND version=$3")
        .bind(tenant).bind(proposal).bind(version).fetch_one(&mut **tx).await.map_err(db)
}

fn unavailable() -> Response {
    response(
        StatusCode::SERVICE_UNAVAILABLE,
        None,
        json!({"status":503,"title":"A validação comercial da proposta está indisponível. Nenhuma mensagem foi enviada."}),
    )
}

pub(super) async fn check(
    state: &AppState,
    headers: &HeaderMap,
    mcp: Option<&McpDispatchCredential>,
    tenant: Uuid,
    proposal: Uuid,
    expected: i64,
) -> Result<Value, Response> {
    if state.typescript.is_none() {
        return Err(unavailable());
    }
    let mut request = Request::builder()
        .method("POST")
        .uri(format!(
            "/api/v1/proposals/{proposal}/commercial-validation"
        ))
        .body(Body::from("{}"))
        .map_err(|_| unavailable())?;
    *request.headers_mut() = headers.clone();
    request.headers_mut().remove("content-length");
    request.headers_mut().insert(
        "content-type",
        axum::http::HeaderValue::from_static("application/json"),
    );
    if let Some(credential) = mcp {
        request.extensions_mut().insert(credential.clone());
    }
    let checked =
        crate::platform::typescript_gateway::dispatch(State(state.clone()), request).await;
    if checked.status() != StatusCode::OK {
        return Err(checked);
    }
    let bytes = to_bytes(checked.into_body(), 1_000_000)
        .await
        .map_err(|_| unavailable())?;
    let body: Value = serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
    if body["tenantId"].as_str() != Some(tenant.to_string().as_str())
        || body["revision"].as_i64() != Some(expected)
        || body.get("approvalCandidate").is_none()
    {
        return Err(unavailable());
    }
    Ok(body["approvalCandidate"].clone())
}
