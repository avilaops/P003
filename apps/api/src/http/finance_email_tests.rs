//! Financial documents exercise real permissions/RLS and loopback-only SMTP.
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;
const TENANT: &str = "11111111-1111-4111-8111-111111111111";

async fn seed(admin: &PgPool) -> Uuid {
    sqlx::raw_sql("INSERT INTO role_permissions(role_id,permission_code) SELECT '99999999-9999-4999-8999-999999999999'::uuid,code FROM permissions WHERE code IN ('finance.receivables.read','finance.receivables.manage','finance.payables.read','finance.payables.manage') ON CONFLICT DO NOTHING;
    INSERT INTO role_permissions(role_id,permission_code) SELECT 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,code FROM permissions WHERE code IN ('finance.receivables.read','finance.payables.read') ON CONFLICT DO NOTHING;
    INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,email,is_customer,is_supplier,status) VALUES('11111111-2222-4333-8444-555555555555','11111111-1111-4111-8111-111111111111','fisica','João São José','52998224725','cliente@example.test',true,false,'active');")
        .execute(admin).await.unwrap();
    let order = Uuid::now_v7();
    let id = Uuid::now_v7();
    sqlx::query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2::uuid,'11111111-2222-4333-8444-555555555555','João São José','52998224725','2027-01-01',12345,'draft')").bind(order).bind(TENANT).execute(admin).await.unwrap();
    sqlx::query("INSERT INTO receivables(id,tenant_id,order_id,customer_name,due_date,amount_cents,status) VALUES($1,$2::uuid,$3,'João São José','2027-01-01',12345,'open')").bind(id).bind(TENANT).bind(order).execute(admin).await.unwrap();
    id
}

async fn call(
    router: &Router,
    method: &str,
    url: &str,
    subject: &str,
    key: Option<Uuid>,
    body: Value,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(url)
        .header("x-tenant-id", TENANT)
        .header("authorization", format!("Bearer {subject}"))
        .header("content-type", "application/json")
        .header("if-match", "\"1\"");
    if let Some(key) = key {
        request = request.header("idempotency-key", key.to_string());
    }
    let response = router
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 2_000_000).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
fn payload(status: &Value) -> Value {
    json!({"recipient":"cliente@example.test","subject":"Documento financeiro","message":"Segue o documento conferido.","snapshotHash":status["snapshotHash"]})
}

#[sqlx::test(migrations = "../../migrations")]
async fn finance_email_enforces_permissions_hash_and_no_smtp_side_effects(admin: PgPool) {
    let (router, application, server, role) = super::company_tests::setup(&admin).await;
    let id = seed(&admin).await;
    let url = format!("/api/v1/receivables/{id}/email");
    let status = call(&router, "GET", &url, "editor", None, Value::Null).await;
    assert_eq!(status.0, StatusCode::OK);
    assert_eq!(status.1["canSend"], true);
    assert_eq!(status.1["emailReady"], false);
    assert_eq!(status.1["recipient"], "cliente@example.test");
    assert_eq!(status.1["recordCount"], 1);
    let body = payload(&status.1);
    assert_eq!(
        call(
            &router,
            "POST",
            &url,
            "reader",
            Some(Uuid::now_v7()),
            body.clone()
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(&router, "GET", &url, "disabled", None, Value::Null)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &router,
            "POST",
            &url,
            "editor",
            Some(Uuid::now_v7()),
            body.clone()
        )
        .await
        .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    let mut arbitrary = body.clone();
    arbitrary["html"] = json!("<h1>Arbitrary</h1>");
    assert_eq!(
        call(
            &router,
            "POST",
            &url,
            "editor",
            Some(Uuid::now_v7()),
            arbitrary
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let report = call(
        &router,
        "GET",
        "/api/v1/financial-report/email",
        "editor",
        None,
        Value::Null,
    )
    .await;
    assert_eq!(report.0, StatusCode::OK);
    assert_eq!(report.1["recordCount"], 1);
    sqlx::query("UPDATE receivables SET revision=revision+1,amount_cents=12346 WHERE id=$1")
        .bind(id)
        .execute(&admin)
        .await
        .unwrap();
    assert_eq!(
        call(&router, "POST", &url, "editor", Some(Uuid::now_v7()), body)
            .await
            .0,
        StatusCode::PRECONDITION_FAILED
    );
    assert_eq!(
        call(
            &router,
            "POST",
            "/api/v1/financial-report/email",
            "editor",
            Some(Uuid::now_v7()),
            payload(&report.1)
        )
        .await
        .0,
        StatusCode::PRECONDITION_FAILED
    );
    sqlx::query("DELETE FROM role_permissions WHERE role_id='99999999-9999-4999-8999-999999999999' AND permission_code='finance.payables.read'").execute(&admin).await.unwrap();
    assert_eq!(
        call(
            &router,
            "GET",
            "/api/v1/financial-report/email",
            "editor",
            None,
            Value::Null
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM finance_document_email_deliveries")
            .fetch_one(&admin)
            .await
            .unwrap(),
        0
    );
    super::company_tests::cleanup(&admin, application, server, &role).await;
}

async fn smtp(mode: &'static str, admin: PgPool) -> (u16, tokio::task::JoinHandle<String>) {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut io = BufReader::new(socket);
        io.get_mut()
            .write_all(b"220 loopback.test ESMTP\r\n")
            .await
            .unwrap();
        let mut captured = String::new();
        let mut data = false;
        loop {
            let mut line = String::new();
            if io.read_line(&mut line).await.unwrap() == 0 {
                break;
            }
            if data {
                if line == ".\r\n" {
                    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM finance_document_email_deliveries WHERE status='uncertain'").fetch_one(&admin).await.unwrap(),1,"intent must be committed before SMTP DATA");
                    if mode == "uncertain" {
                        break;
                    }
                    io.get_mut()
                        .write_all(if mode == "failed" {
                            b"550 Rejected\r\n"
                        } else {
                            b"250 Accepted\r\n"
                        })
                        .await
                        .unwrap();
                    break;
                } else {
                    captured.push_str(&line);
                }
            } else if line.starts_with("DATA") {
                data = true;
                io.get_mut()
                    .write_all(b"354 End with dot\r\n")
                    .await
                    .unwrap();
            } else if line.starts_with("QUIT") {
                io.get_mut().write_all(b"221 Bye\r\n").await.unwrap();
                break;
            } else {
                io.get_mut()
                    .write_all(b"250 loopback.test\r\n")
                    .await
                    .unwrap();
            }
        }
        captured
    });
    (port, task)
}

fn smtp_router(application: PgPool, port: u16) -> Router {
    use crate::{
        domains::finance::email,
        platform::{
            auth::{AuthClient, AuthenticatedIdentity},
            mail::SmtpMailer,
            state::AppState,
        },
    };
    // Identity middleware is exercised above; SMTP tests inject the verified identity
    // while retaining the actual domain authorization and restricted database role.
    Router::new()
        .route(
            "/api/v1/receivables/{id}/email",
            axum::routing::get(email::get_receivable).post(email::send_receivable),
        )
        .route(
            "/api/v1/financial-report/email",
            axum::routing::get(email::get_report).post(email::send_report),
        )
        .layer(axum::Extension(AuthenticatedIdentity {
            subject: "editor".into(),
            email: "editor@example.test".into(),
            name: "Editor".into(),
        }))
        .with_state(
            AppState::new(
                application,
                AuthClient::new("http://127.0.0.1:1/unused".into()),
            )
            .with_mail(Some(SmtpMailer::loopback_test(port))),
        )
}

async fn smtp_case(admin: PgPool, mode: &'static str, report: bool) {
    use base64::Engine;

    let (_, application, server, role) = super::company_tests::setup(&admin).await;
    let id = seed(&admin).await;
    let url = if report {
        "/api/v1/financial-report/email".to_owned()
    } else {
        format!("/api/v1/receivables/{id}/email")
    };
    let (port, smtp) = smtp(mode, admin.clone()).await;
    let router = smtp_router(application.clone(), port);
    let status = call(&router, "GET", &url, "editor", None, Value::Null).await;
    assert_eq!(status.0, StatusCode::OK);
    let body = payload(&status.1);
    let key = Uuid::now_v7();
    let sent = call(&router, "POST", &url, "editor", Some(key), body.clone()).await;
    assert_eq!(sent.0, StatusCode::OK, "{}", sent.1);
    assert_eq!(sent.1["delivery"]["status"], mode);
    let captured = tokio::time::timeout(std::time::Duration::from_secs(10), smtp)
        .await
        .unwrap()
        .unwrap();
    assert!(captured.contains("application/pdf"));
    let delivery = Uuid::parse_str(sent.1["delivery"]["id"].as_str().unwrap()).unwrap();
    let (bytes, hash, snapshot): (Vec<u8>, String, Value) = sqlx::query_as(
        "SELECT pdf_content,pdf_sha256,snapshot FROM finance_document_email_deliveries WHERE id=$1",
    )
    .bind(delivery)
    .fetch_one(&admin)
    .await
    .unwrap();
    assert!(
        captured
            .replace("\r\n", "")
            .contains(&base64::engine::general_purpose::STANDARD.encode(&bytes))
    );
    use sha2::{Digest, Sha256};
    assert_eq!(hash, format!("{:x}", Sha256::digest(&bytes)));
    assert_eq!(snapshot["receivables"][0]["amountCents"], 12345);
    let pdf = lopdf::Document::load_mem(&bytes).unwrap();
    let text = pdf
        .extract_text(&pdf.get_pages().keys().copied().collect::<Vec<_>>())
        .unwrap();
    assert!(text.contains("João São José"));
    assert!(text.contains("R$ 123,45"));
    assert!(text.contains(if report {
        "RELATÓRIO FINANCEIRO"
    } else {
        "TÍTULO A RECEBER"
    }));
    sqlx::query("UPDATE receivables SET revision=2,amount_cents=99999 WHERE id=$1")
        .bind(id)
        .execute(&admin)
        .await
        .unwrap();
    let replay = call(&router, "POST", &url, "editor", Some(key), body.clone()).await;
    assert_eq!(replay, sent);
    let mut changed = body.clone();
    changed["subject"] = json!("Alterado");
    assert_eq!(
        call(&router, "POST", &url, "editor", Some(key), changed)
            .await
            .0,
        StatusCode::CONFLICT
    );
    if mode == "uncertain" {
        // Same immutable context blocks a new command even when the source is rechecked.
        let current = call(&router, "GET", &url, "editor", None, Value::Null).await;
        let mut req = Request::builder()
            .method("POST")
            .uri(&url)
            .header("x-tenant-id", TENANT)
            .header("content-type", "application/json")
            .header("if-match", if report { "\"1\"" } else { "\"2\"" });
        req = req.header("idempotency-key", Uuid::now_v7().to_string());
        let result = router
            .clone()
            .oneshot(
                req.body(Body::from(payload(&current.1).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(result.status(), StatusCode::CONFLICT);
    }
    let mut tx = application.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.tenant_id','22222222-2222-4222-8222-222222222222',true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM finance_document_email_deliveries")
            .fetch_one(&mut *tx)
            .await
            .unwrap(),
        0
    );
    tx.rollback().await.unwrap();
    assert!(
        sqlx::query(
            "UPDATE finance_document_email_deliveries SET pdf_content='fake'::bytea WHERE id=$1"
        )
        .bind(delivery)
        .execute(&admin)
        .await
        .is_err()
    );
    assert_eq!(
        sqlx::query_as::<_, (i64, i64)>(
            "SELECT revision,amount_cents FROM receivables WHERE id=$1"
        )
        .bind(id)
        .fetch_one(&admin)
        .await
        .unwrap(),
        (2, 99999)
    );
    super::company_tests::cleanup(&admin, application, server, &role).await;
}

#[sqlx::test(migrations = "../../migrations")]
async fn financial_smtp_sent_snapshot_and_replay(admin: PgPool) {
    smtp_case(admin, "sent", false).await;
}
#[sqlx::test(migrations = "../../migrations")]
async fn financial_smtp_rejection_snapshot_and_replay(admin: PgPool) {
    smtp_case(admin, "failed", false).await;
}
#[sqlx::test(migrations = "../../migrations")]
async fn financial_smtp_uncertain_snapshot_blocks_new_delivery(admin: PgPool) {
    smtp_case(admin, "uncertain", false).await;
}

#[sqlx::test(migrations = "../../migrations")]
async fn financial_report_smtp_captures_authoritative_pdf_and_replays_after_source_changes(
    admin: PgPool,
) {
    smtp_case(admin, "sent", true).await;
}
