use super::company_tests::{cleanup, setup};
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
async fn call(
    router: &Router,
    path: &str,
    who: &str,
    key: Option<Uuid>,
    body: Value,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method("POST")
        .uri(path)
        .header("x-tenant-id", TENANT)
        .header("authorization", format!("Bearer {who}"))
        .header("content-type", "application/json");
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
    (status, serde_json::from_slice(&bytes).unwrap())
}
async fn seed(admin: &PgPool) -> (Value, Uuid, Uuid) {
    let tenant = Uuid::parse_str(TENANT).unwrap();
    let customer = Uuid::now_v7();
    let method = Uuid::now_v7();
    let mut items = Vec::new();
    sqlx::raw_sql("INSERT INTO role_permissions(role_id,permission_code) SELECT '99999999-9999-4999-8999-999999999999'::uuid,code FROM permissions WHERE code IN ('sales.orders.read','sales.orders.manage','catalog.products.read') ON CONFLICT DO NOTHING; INSERT INTO role_permissions(role_id,permission_code) VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','sales.orders.read') ON CONFLICT DO NOTHING;").execute(admin).await.unwrap();
    sqlx::query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$2,'fisica','Cliente misto','52998224725',true,false,'active')").bind(customer).bind(tenant).execute(admin).await.unwrap();
    sqlx::query("INSERT INTO payment_methods(id,tenant_id,code,name,status,revision,modality,settlement_days) VALUES($1,$2,'PIX','Pix combinado','active',1,'pix',0)").bind(method).bind(tenant).execute(admin).await.unwrap();
    for (index, line) in ["imported", "national"].iter().enumerate() {
        let product = Uuid::now_v7();
        let version = Uuid::now_v7();
        let mut p = crate::platform::commercial_settings_model::tests::example();
        p.ipi_bps = if index == 0 { 1300 } else { 0 };
        p.fixed_order_fee_cents = 101;
        let policy = json!(p);
        sqlx::query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,$3,'Equipamento misto','UN',100,'active')").bind(product).bind(tenant).bind(format!("MIXED-{index}")).execute(admin).await.unwrap();
        sqlx::query("INSERT INTO product_costs(tenant_id,product_id,product_line,purchase_cost_cents,tax_credit_bps,packaging_cents,revision) VALUES($1,$2,$3,1000,0,0,1)").bind(tenant).bind(product).bind(line).execute(admin).await.unwrap();
        sqlx::query("INSERT INTO commercial_settings(tenant_id,product_line,parameters,revision) VALUES($1,$2,$3,1)").bind(tenant).bind(line).bind(&policy).execute(admin).await.unwrap();
        sqlx::query("INSERT INTO price_table_versions(id,tenant_id,product_line,version,settings_revision,policy_snapshot,calculator_version,digest,published_by) VALUES($1,$2,$3,1,1,$4,'mixed-test-v1',$5,'33333333-3333-4333-8333-333333333333')").bind(version).bind(tenant).bind(line).bind(&policy).bind("a".repeat(64)).execute(admin).await.unwrap();
        sqlx::query("INSERT INTO price_table_items(tenant_id,version_id,product_id,product_snapshot,cost_revision,cost_snapshot,price_without_ipi_cents,ipi_bps,price_with_ipi_cents) VALUES($1,$2,$3,$4,1,$5,30001,$6,$7)").bind(tenant).bind(version).bind(product).bind(json!({"sku":format!("MIXED-{index}"),"name":"Equipamento misto","unit":"UN","revision":1})).bind(json!({"purchaseCostCents":1000,"taxCreditBps":0,"packagingCents":0})).bind(p.ipi_bps as i32).bind(if index==0{33902_i64}else{30001_i64}).execute(admin).await.unwrap();
        sqlx::query("UPDATE commercial_settings SET active_price_version_id=$3 WHERE tenant_id=$1 AND product_line=$2").bind(tenant).bind(line).bind(version).execute(admin).await.unwrap();
        items.push(json!({"line":line,"versionId":version,"productId":product,"quantity":3}));
    }
    sqlx::query("INSERT INTO commercial_approval_settings(tenant_id,revision,rules) VALUES($1,1,$2)").bind(tenant).bind(json!({"belowTarget":true,"freight":false,"directorAutoApproval":false,"managerLimit":"profit"})).execute(admin).await.unwrap();
    (
        json!({"destinationState":"SP","taxpayer":false,"discount":{"kind":"percent","value":0},"freightCents":103,"items":items}),
        customer,
        method,
    )
}

#[sqlx::test(migrations = "../../migrations")]
async fn mixed_order_preserves_two_sources_checkout_replay_and_immutable_provenance(admin: PgPool) {
    let (router, app, server, role) = setup(&admin).await;
    let (input, customer, method) = seed(&admin).await;
    let quote = call(
        &router,
        "/api/v1/commercial/mixed/simulate",
        "reader",
        None,
        input.clone(),
    )
    .await;
    assert_eq!(quote.0, StatusCode::OK, "{}", quote.1);
    assert_eq!(quote.1["director"], Value::Null);
    assert_eq!(quote.1["sale"]["ipiBps"], Value::Null);
    assert_eq!(quote.1["sale"]["policyGroups"].as_array().unwrap().len(), 2);
    assert!(!quote.1["sale"].to_string().contains("equipmentCostCents"));
    assert!(!quote.1["sale"].to_string().contains("purchaseCents"));
    assert!(!quote.1["sale"].to_string().contains("fixedOrderFeeCents"));
    assert!(!quote.1["sale"].to_string().contains("fixedFeeCents"));
    let total = quote.1["sale"]["totalCents"].as_i64().unwrap();
    let entry = quote.1["sale"]["downPaymentCents"].as_i64().unwrap();
    let request = json!({"simulation":input,"digest":quote.1["digest"],"customerId":customer,"dueDate":"2027-03-01","checkout":{"entry":{"paymentMethodId":method,"dueOn":null},"installments":[{"paymentMethodId":method,"dueOn":"2027-03-01","amountCents":total-entry}],"manufacturingDays":30,"deliveryNotes":"Entrega combinada","paymentNotes":"Condições preservadas","notes":"","stateRegistration":"ISENTO"}});
    assert_eq!(
        call(
            &router,
            "/api/v1/commercial/mixed/orders",
            "reader",
            Some(Uuid::now_v7()),
            request.clone()
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let key = Uuid::now_v7();
    let converted = call(
        &router,
        "/api/v1/commercial/mixed/orders",
        "editor",
        Some(key),
        request.clone(),
    )
    .await;
    assert_eq!(converted.0, StatusCode::CREATED, "{}", converted.1);
    let order = Uuid::parse_str(converted.1["id"].as_str().unwrap()).unwrap();
    let stored: (Option<Uuid>, Value) = sqlx::query_as(
        "SELECT price_version_id,public_snapshot FROM commercial_order_quotes WHERE order_id=$1",
    )
    .bind(order)
    .fetch_one(&admin)
    .await
    .unwrap();
    assert!(stored.0.is_none());
    assert_eq!(stored.1["sale"], quote.1["sale"]);
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM commercial_order_quote_versions WHERE order_id=$1"
        )
        .bind(order)
        .fetch_one(&admin)
        .await
        .unwrap(),
        2
    );
    let (lines,net):(i64,i64)=sqlx::query_as("SELECT sum(amount_cents)::bigint,sum(price_cents*quantity_micros/1000000)::bigint FROM sales_order_lines WHERE order_id=$1").bind(order).fetch_one(&admin).await.unwrap();
    assert_eq!((lines, net), (total, total));
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT sum(amount_cents)::bigint FROM sales_order_installments WHERE order_id=$1"
        )
        .bind(order)
        .fetch_one(&admin)
        .await
        .unwrap(),
        total
    );
    sqlx::query("UPDATE commercial_settings SET revision=2 WHERE tenant_id=$1::uuid AND product_line='national'").bind(TENANT).execute(&admin).await.unwrap();
    assert_eq!(
        call(
            &router,
            "/api/v1/commercial/mixed/orders",
            "editor",
            Some(key),
            request.clone()
        )
        .await,
        converted
    );
    assert!(
        call(
            &router,
            "/api/v1/commercial/mixed/orders",
            "editor",
            Some(Uuid::now_v7()),
            request.clone()
        )
        .await
        .0
        .is_client_error()
    );
    let mut changed = request;
    changed["dueDate"] = json!("2027-04-01");
    assert_eq!(
        call(
            &router,
            "/api/v1/commercial/mixed/orders",
            "editor",
            Some(key),
            changed
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let mut tx = app.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.tenant_id','22222222-2222-4222-8222-222222222222',true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM commercial_order_quote_versions")
            .fetch_one(&mut *tx)
            .await
            .unwrap(),
        0
    );
    tx.rollback().await.unwrap();
    assert!(
        sqlx::query(
            "UPDATE commercial_order_quote_versions SET version_snapshot='{}' WHERE order_id=$1"
        )
        .bind(order)
        .execute(&admin)
        .await
        .is_err()
    );
    cleanup(&admin, app, server, &role).await;
}

#[sqlx::test(migrations = "../../migrations")]
async fn mixed_quote_rejects_missing_foreign_and_stale_provenance(admin: PgPool) {
    let (router, app, server, role) = setup(&admin).await;
    let (input, _, _) = seed(&admin).await;
    let mut changed = input.clone();
    changed["items"][1]["versionId"] = json!(Uuid::now_v7());
    assert_eq!(
        call(
            &router,
            "/api/v1/commercial/mixed/simulate",
            "reader",
            None,
            changed
        )
        .await
        .0,
        StatusCode::PRECONDITION_FAILED
    );
    let mut changed = input.clone();
    changed["items"][1].as_object_mut().unwrap().remove("line");
    assert_eq!(
        call(
            &router,
            "/api/v1/commercial/mixed/simulate",
            "reader",
            None,
            changed
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    sqlx::query("UPDATE products SET revision=revision+1,price_cents=price_cents+1 WHERE id=$1")
        .bind(Uuid::parse_str(input["items"][0]["productId"].as_str().unwrap()).unwrap())
        .execute(&admin)
        .await
        .unwrap();
    assert_eq!(
        call(
            &router,
            "/api/v1/commercial/mixed/simulate",
            "reader",
            None,
            input
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    cleanup(&admin, app, server, &role).await;
}
