//! Financial SMTP intents are durable before the external boundary.
use super::super::{
    DomainChange, DomainError, authorized, command_key, db, record, remember, replay, response,
    revision,
};
use super::document::Snapshot;
use crate::platform::{access, auth::AuthenticatedIdentity, mail::MailAttachment, state::AppState};
use axum::{
    Extension, Json,
    extract::{Path, State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode},
    response::Response,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, Postgres, Transaction};
use utoipa::ToSchema;
use uuid::Uuid;

#[derive(Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FinanceEmailInput {
    recipient: String,
    subject: String,
    message: String,
    snapshot_hash: String,
}

#[derive(Serialize, FromRow, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FinanceEmailDelivery {
    id: Uuid,
    status: String,
    recipient: String,
    created_at: String,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FinanceEmailStatus {
    tenant_id: Uuid,
    can_send: bool,
    email_ready: bool,
    recipient: Option<String>,
    document_title: String,
    scope: String,
    record_count: usize,
    snapshot_hash: String,
    deliveries: Vec<FinanceEmailDelivery>,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FinanceEmailReceipt {
    tenant_id: Uuid,
    revision: i64,
    delivery: FinanceEmailDelivery,
}

const HISTORY: &str = "SELECT id,status,recipient,created_at::text AS created_at FROM finance_document_email_deliveries";

async fn authorize<'a>(
    state: &'a AppState,
    headers: &HeaderMap,
    identity: &AuthenticatedIdentity,
    id: Option<Uuid>,
    write: bool,
) -> Result<(Uuid, Transaction<'a, Postgres>, bool), DomainError> {
    let (tenant, mut tx, mut manage) = authorized(
        state,
        headers,
        identity,
        "finance.receivables.read",
        "finance.receivables.manage",
        write,
    )
    .await?;
    if id.is_none() {
        let rights = access::load_access(&mut tx, tenant, &identity.subject).await?;
        access::require_permission(&rights, "finance.payables.read")?;
        let payables_manage =
            access::require_permission(&rights, "finance.payables.manage").is_ok();
        if write && !payables_manage {
            return Err(access::AccessError::Forbidden.into());
        }
        manage &= payables_manage;
    }
    Ok((tenant, tx, manage))
}

// One PostgreSQL statement captures both sources, their ledgers and issuer from the
// same MVCC snapshot. POST holds the tenant command lock before reading it.
async fn capture(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    id: Option<Uuid>,
) -> Result<Snapshot, DomainError> {
    let value: Value = sqlx::query_scalar(r#"
      SELECT jsonb_build_object('tenantId',t.id,
        'company',jsonb_build_object('legalName',t.legal_name,'taxId',t.tax_id,'details',COALESCE(cp.details,'{}'::jsonb)),
        'recipient',CASE WHEN $2::uuid IS NULL THEN NULL ELSE (SELECT COALESCE(c.customer_snapshot->>'email',p.email) FROM receivables r JOIN sales_orders o ON o.tenant_id=r.tenant_id AND o.id=r.order_id JOIN parties p ON p.tenant_id=o.tenant_id AND p.id=o.customer_id LEFT JOIN sales_order_checkouts c ON c.tenant_id=o.tenant_id AND c.order_id=o.id WHERE r.tenant_id=$1 AND r.id=$2) END,
        'receivables',COALESCE((SELECT jsonb_agg(row_data ORDER BY due_date,id) FROM (
          SELECT r.due_date,r.id,jsonb_build_object('id',r.id,'party',r.customer_name,'dueDate',r.due_date::text,'amountCents',r.amount_cents,'settledCents',totals.amount,'outstandingCents',CASE WHEN r.status='cancelled' THEN 0 ELSE r.amount_cents-totals.amount END,'status',r.status,'revision',r.revision,'sourceId',r.order_id) AS row_data
          FROM receivables r CROSS JOIN LATERAL(SELECT COALESCE(sum(CASE WHEN p.kind='receipt' THEN p.amount_cents ELSE -p.amount_cents END),0)::bigint AS amount FROM receivable_payments p WHERE p.tenant_id=r.tenant_id AND p.receivable_id=r.id) totals
          WHERE r.tenant_id=$1 AND ($2::uuid IS NULL OR r.id=$2) ORDER BY r.due_date,r.id LIMIT 100
        ) rows),'[]'::jsonb),
        'payables',CASE WHEN $2::uuid IS NOT NULL THEN '[]'::jsonb ELSE COALESCE((SELECT jsonb_agg(row_data ORDER BY due_date,id) FROM (
          SELECT r.due_date,r.id,jsonb_build_object('id',r.id,'party',r.supplier_name,'dueDate',r.due_date::text,'amountCents',r.amount_cents,'settledCents',totals.amount,'outstandingCents',CASE WHEN r.status='cancelled' THEN 0 ELSE r.amount_cents-totals.amount END,'status',r.status,'revision',r.revision) AS row_data
          FROM payables r CROSS JOIN LATERAL(SELECT COALESCE(sum(CASE WHEN p.kind='payment' THEN p.amount_cents ELSE -p.amount_cents END),0)::bigint AS amount FROM payable_payments p WHERE p.tenant_id=r.tenant_id AND p.payable_id=r.id) totals
          WHERE r.tenant_id=$1 ORDER BY r.due_date,r.id LIMIT 100
        ) rows),'[]'::jsonb) END)
      FROM tenants t LEFT JOIN company_profiles cp ON cp.tenant_id=t.id WHERE t.id=$1
    "#).bind(tenant).bind(id).fetch_one(&mut **tx).await.map_err(db)?;
    let snapshot: Snapshot =
        serde_json::from_value(value).map_err(|_| access::AccessError::Internal)?;
    if id.is_some() && snapshot.receivables.is_empty() {
        return Err(DomainError::NotFound);
    }
    Ok(snapshot)
}

fn context(id: Option<Uuid>) -> &'static str {
    if id.is_some() { "receivable" } else { "report" }
}
fn source_revision(snapshot: &Snapshot, id: Option<Uuid>) -> i64 {
    if id.is_some() {
        snapshot.receivables[0].revision
    } else {
        1
    }
}

async fn get_status(
    state: AppState,
    identity: AuthenticatedIdentity,
    headers: HeaderMap,
    id: Option<Uuid>,
) -> Result<Response, DomainError> {
    let (tenant, mut tx, manage) = authorize(&state, &headers, &identity, id, false).await?;
    let snapshot = capture(&mut tx, tenant, id).await?;
    let deliveries = sqlx::query_as::<_, FinanceEmailDelivery>(&format!("{HISTORY} WHERE tenant_id=$1 AND context=$2 AND receivable_id IS NOT DISTINCT FROM $3 ORDER BY created_at DESC,id DESC LIMIT 50"))
        .bind(tenant).bind(context(id)).bind(id).fetch_all(&mut *tx).await.map_err(db)?;
    let value = FinanceEmailStatus {
        tenant_id: tenant,
        can_send: manage && (id.is_none() || snapshot.receivables[0].status != "cancelled"),
        email_ready: crate::platform::mail_settings::resolve_in(&state, &mut tx)
            .await?
            .is_some(),
        recipient: snapshot.recipient.clone(),
        document_title: snapshot.title(id.is_some()).into(),
        scope: snapshot.scope(id.is_some()).into(),
        record_count: snapshot.receivables.len() + snapshot.payables.len(),
        snapshot_hash: snapshot.hash(),
        deliveries,
    };
    let revision = source_revision(&snapshot, id);
    tx.commit().await.map_err(db)?;
    Ok(response(StatusCode::OK, Some(revision), value))
}

fn normalize(mut input: FinanceEmailInput) -> Result<FinanceEmailInput, DomainError> {
    if input.recipient.chars().any(char::is_control) || input.subject.chars().any(char::is_control)
    {
        return Err(DomainError::Invalid(
            "Endereço e assunto não podem conter caracteres de controle",
        ));
    }
    input.recipient = input.recipient.trim().into();
    input.subject = input.subject.trim().into();
    input.message = input.message.trim().into();
    if input.recipient.len() > 254
        || input
            .recipient
            .chars()
            .any(|c| c.is_whitespace() || c.is_control())
        || input.recipient.parse::<lettre::Address>().is_err()
    {
        return Err(DomainError::Invalid(
            "Informe um único endereço de e-mail válido",
        ));
    }
    if input.subject.is_empty()
        || input.subject.chars().count() > 200
        || input.message.is_empty()
        || input.message.chars().count() > 10000
        || input
            .message
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err(DomainError::Invalid(
            "Confira o assunto e a mensagem do e-mail",
        ));
    }
    if input.snapshot_hash.len() != 64
        || !input
            .snapshot_hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(DomainError::Invalid(
            "Reabra a conferência do documento financeiro",
        ));
    }
    Ok(input)
}

async fn receipt(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    delivery: Uuid,
) -> Result<FinanceEmailReceipt, DomainError> {
    let revision = sqlx::query_scalar("SELECT source_revision FROM finance_document_email_deliveries WHERE tenant_id=$1 AND id=$2")
        .bind(tenant).bind(delivery).fetch_one(&mut **tx).await.map_err(db)?;
    let delivery = sqlx::query_as::<_, FinanceEmailDelivery>(&format!(
        "{HISTORY} WHERE tenant_id=$1 AND id=$2"
    ))
    .bind(tenant)
    .bind(delivery)
    .fetch_one(&mut **tx)
    .await
    .map_err(db)?;
    Ok(FinanceEmailReceipt {
        tenant_id: tenant,
        revision,
        delivery,
    })
}

async fn send_document(
    state: AppState,
    identity: AuthenticatedIdentity,
    headers: HeaderMap,
    id: Option<Uuid>,
    payload: Result<Json<FinanceEmailInput>, JsonRejection>,
) -> Result<Response, DomainError> {
    let key = command_key(&headers)?;
    let expected = revision(&headers)?;
    let (tenant, mut tx, _) = authorize(&state, &headers, &identity, id, true).await?;
    let Json(input) =
        payload.map_err(|_| DomainError::Invalid("JSON inválido ou campos desconhecidos"))?;
    let input = normalize(input)?;
    let request = json!({"context":context(id),"id":id,"revision":expected,"input":input});
    if let Some(previous) = replay(
        &mut tx,
        tenant,
        &identity.subject,
        key,
        "finance.document_email",
        &request,
    )
    .await?
    {
        let delivery = previous["deliveryId"]
            .as_str()
            .and_then(|v| Uuid::parse_str(v).ok())
            .ok_or(access::AccessError::Internal)?;
        let value = receipt(&mut tx, tenant, delivery).await?;
        tx.commit().await.map_err(db)?;
        return Ok(response(StatusCode::OK, Some(value.revision), value));
    }
    let snapshot = capture(&mut tx, tenant, id).await?;
    if source_revision(&snapshot, id) != expected || snapshot.hash() != input.snapshot_hash {
        return Err(DomainError::StaleRevision);
    }
    if id.is_some() && snapshot.receivables[0].status == "cancelled" {
        return Err(DomainError::Conflict(
            "Títulos cancelados não podem ser enviados por e-mail",
        ));
    }
    let pending: bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM finance_document_email_deliveries WHERE tenant_id=$1 AND context=$2 AND receivable_id IS NOT DISTINCT FROM $3 AND status='uncertain')")
        .bind(tenant).bind(context(id)).bind(id).fetch_one(&mut *tx).await.map_err(db)?;
    if pending {
        return Err(DomainError::Conflict(
            "Existe um envio sem confirmação definitiva. Confira o resultado com o provedor antes de reenviar",
        ));
    }
    let Some(mailer) = crate::platform::mail_settings::resolve_in(&state, &mut tx).await? else {
        return Ok(response(
            StatusCode::SERVICE_UNAVAILABLE,
            None,
            json!({"title":"O envio de e-mail não está configurado. Nenhuma mensagem foi enviada.","status":503}),
        ));
    };
    let bytes = snapshot
        .pdf(id.is_some(), expected)
        .map_err(|_| access::AccessError::Internal)?;
    let filename = match id {
        Some(id) => format!("titulo-{id}.pdf"),
        None => "relatorio-financeiro.pdf".into(),
    };
    let delivery = Uuid::now_v7();
    sqlx::query("INSERT INTO finance_document_email_deliveries(id,tenant_id,context,receivable_id,source_revision,subject_id,command_key,recipient,subject,message,snapshot,snapshot_hash,pdf_content,pdf_sha256,filename,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'uncertain')")
        .bind(delivery).bind(tenant).bind(context(id)).bind(id).bind(expected).bind(&identity.subject).bind(key).bind(&input.recipient).bind(&input.subject).bind(&input.message).bind(serde_json::to_value(&snapshot).map_err(|_|access::AccessError::Internal)?).bind(&input.snapshot_hash).bind(&bytes).bind(super::document::digest(&bytes)).bind(&filename).execute(&mut *tx).await.map_err(db)?;
    record(&mut tx,tenant,&identity,&headers,DomainChange{kind:"finance_document",id:id.unwrap_or(tenant),event:"finance.email_requested",details:json!({"deliveryId":delivery,"context":context(id),"snapshotHash":input.snapshot_hash})}).await?;
    remember(
        &mut tx,
        tenant,
        &identity.subject,
        key,
        "finance.document_email",
        &request,
        &json!({"deliveryId":delivery}),
    )
    .await?;
    tx.commit().await.map_err(db)?;
    let result = mailer
        .send_with_attachments(
            std::slice::from_ref(&input.recipient),
            &input.subject,
            &input.message,
            &[MailAttachment {
                filename,
                content_type: "application/pdf".into(),
                bytes,
            }],
        )
        .await;
    let status = delivery_status(&result);
    let mut tx = access::tenant_transaction(&state, tenant).await?;
    sqlx::query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE")
        .bind(tenant)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    sqlx::query("UPDATE finance_document_email_deliveries SET status=$3,sent_at=CASE WHEN $3='sent' THEN now() ELSE NULL END,updated_at=now() WHERE tenant_id=$1 AND id=$2")
        .bind(tenant).bind(delivery).bind(status).execute(&mut *tx).await.map_err(db)?;
    record(
        &mut tx,
        tenant,
        &identity,
        &headers,
        DomainChange {
            kind: "finance_document",
            id: id.unwrap_or(tenant),
            event: match status {
                "sent" => "finance.email_sent",
                "failed" => "finance.email_failed",
                _ => "finance.email_uncertain",
            },
            details: json!({"deliveryId":delivery,"context":context(id)}),
        },
    )
    .await?;
    let value = receipt(&mut tx, tenant, delivery).await?;
    tx.commit().await.map_err(db)?;
    Ok(response(StatusCode::OK, Some(value.revision), value))
}

fn delivery_status(result: &anyhow::Result<()>) -> &'static str {
    match result {
        Ok(()) => "sent",
        Err(error)
            if error
                .downcast_ref::<lettre::transport::smtp::Error>()
                .is_some_and(|smtp| smtp.is_transient() || smtp.is_permanent()) =>
        {
            "failed"
        }
        Err(_) => "uncertain",
    }
}

#[utoipa::path(get,path="/api/v1/receivables/{id}/email",tag="Finance",security(("bearerAuth"=[])),params(("id"=Uuid,Path),("X-Tenant-Id"=Uuid,Header)),responses((status=200,body=FinanceEmailStatus),(status=403,description="Sem permissão")))]
pub async fn get_receivable(
    State(state): State<AppState>,
    Extension(identity): Extension<AuthenticatedIdentity>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response, DomainError> {
    get_status(state, identity, headers, Some(id)).await
}
#[utoipa::path(post,path="/api/v1/receivables/{id}/email",tag="Finance",request_body=FinanceEmailInput,security(("bearerAuth"=[])),params(("id"=Uuid,Path),("X-Tenant-Id"=Uuid,Header),("If-Match"=String,Header),("Idempotency-Key"=Uuid,Header)),responses((status=200,body=FinanceEmailReceipt),(status=412,description="Documento alterado"),(status=503,description="SMTP indisponível")))]
pub async fn send_receivable(
    State(state): State<AppState>,
    Extension(identity): Extension<AuthenticatedIdentity>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    payload: Result<Json<FinanceEmailInput>, JsonRejection>,
) -> Result<Response, DomainError> {
    send_document(state, identity, headers, Some(id), payload).await
}
#[utoipa::path(get,path="/api/v1/financial-report/email",tag="Finance",security(("bearerAuth"=[])),params(("X-Tenant-Id"=Uuid,Header)),responses((status=200,body=FinanceEmailStatus),(status=403,description="Sem permissão")))]
pub async fn get_report(
    State(state): State<AppState>,
    Extension(identity): Extension<AuthenticatedIdentity>,
    headers: HeaderMap,
) -> Result<Response, DomainError> {
    get_status(state, identity, headers, None).await
}
#[utoipa::path(post,path="/api/v1/financial-report/email",tag="Finance",request_body=FinanceEmailInput,security(("bearerAuth"=[])),params(("X-Tenant-Id"=Uuid,Header),("If-Match"=String,Header),("Idempotency-Key"=Uuid,Header)),responses((status=200,body=FinanceEmailReceipt),(status=412,description="Documento alterado"),(status=503,description="SMTP indisponível")))]
pub async fn send_report(
    State(state): State<AppState>,
    Extension(identity): Extension<AuthenticatedIdentity>,
    headers: HeaderMap,
    payload: Result<Json<FinanceEmailInput>, JsonRejection>,
) -> Result<Response, DomainError> {
    send_document(state, identity, headers, None, payload).await
}
