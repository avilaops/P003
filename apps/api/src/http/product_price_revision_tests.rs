//! Actual PostgreSQL trigger and published-price regressions. No catalogue writes
//! outside the isolated sqlx databases are performed.
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
async fn request(router: &Router, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("x-tenant-id", TENANT)
                .header("authorization", "Bearer editor")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 2_000_000).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[sqlx::test(migrations = "../../migrations")]
async fn pricing_revision_backfill_preserves_stale_rows_and_never_accepts_manual_resets(
    admin: PgPool,
) {
    let mut tx = admin.begin().await.unwrap();
    let schema = format!("price_revision_{}", Uuid::now_v7().simple());
    sqlx::raw_sql(&format!("CREATE SCHEMA {schema}; SET LOCAL search_path TO {schema},public; CREATE TABLE products(id integer PRIMARY KEY,revision bigint NOT NULL DEFAULT 1,unit text NOT NULL DEFAULT 'UN',status text NOT NULL DEFAULT 'active',price_cents bigint NOT NULL DEFAULT 100,structure_colors text[],swing_arm_colors text[],upholstery_colors text[],finishing_palette text,plate_holder_colors text[],plate_holder_types text[],plate_holder_type text,updated_at timestamptz DEFAULT now()); INSERT INTO products(id,revision) VALUES(1,1),(2,7);")) .execute(&mut *tx).await.unwrap();
    sqlx::raw_sql(include_str!(
        "../../../../migrations/202611160002_product_price_revision.sql"
    ))
    .execute(&mut *tx)
    .await
    .unwrap();
    assert_eq!(
        sqlx::query_as::<_, (i64, i64)>("SELECT revision,price_revision FROM products WHERE id=2")
            .fetch_one(&mut *tx)
            .await
            .unwrap(),
        (7, 7)
    );
    sqlx::query("UPDATE products SET structure_colors=ARRAY['Azul'],swing_arm_colors=ARRAY['Preto'],upholstery_colors=ARRAY['Café'],finishing_palette='dhz-hammerforce-pro',plate_holder_colors=ARRAY['Azul'],plate_holder_types=ARRAY['Standard'],plate_holder_type='Standard',revision=8,price_revision=1,updated_at=now() WHERE id=2").execute(&mut *tx).await.unwrap();
    assert_eq!(
        sqlx::query_as::<_, (i64, i64)>("SELECT revision,price_revision FROM products WHERE id=2")
            .fetch_one(&mut *tx)
            .await
            .unwrap(),
        (8, 7)
    );
    sqlx::query("UPDATE products SET unit='KG',revision=9,price_revision=1 WHERE id=2")
        .execute(&mut *tx)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_as::<_, (i64, i64)>("SELECT revision,price_revision FROM products WHERE id=2")
            .fetch_one(&mut *tx)
            .await
            .unwrap(),
        (9, 9)
    );
    sqlx::query("UPDATE products SET price_revision=1 WHERE id=2")
        .execute(&mut *tx)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT price_revision FROM products WHERE id=2")
            .fetch_one(&mut *tx)
            .await
            .unwrap(),
        9
    );
    sqlx::query("UPDATE products SET price_cents=101 WHERE id=2")
        .execute(&mut *tx)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT price_revision FROM products WHERE id=2")
            .fetch_one(&mut *tx)
            .await
            .unwrap(),
        10
    );
    sqlx::query("INSERT INTO products(id,revision,price_revision) VALUES(3,12,1)")
        .execute(&mut *tx)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT price_revision FROM products WHERE id=3")
            .fetch_one(&mut *tx)
            .await
            .unwrap(),
        12
    );
    tx.rollback().await.unwrap();
}

#[sqlx::test(migrations = "../../migrations")]
async fn color_edits_keep_valid_prices_simulation_and_digest_without_repairing_stale_publications(
    admin: PgPool,
) {
    let (router, app, server, role) = setup(&admin).await;
    let (version, products, _) = super::commercial_table_tests::seed(&admin).await;
    sqlx::raw_sql("INSERT INTO role_permissions(role_id,permission_code) VALUES('99999999-9999-4999-8999-999999999999','catalog.products.read') ON CONFLICT DO NOTHING").execute(&admin).await.unwrap();
    let tenant = Uuid::parse_str(TENANT).unwrap();
    let valid = products[0];
    let stale = products[1];
    sqlx::query("UPDATE products SET revision=revision+1,price_cents=price_cents+1 WHERE id=$1")
        .bind(stale)
        .execute(&admin)
        .await
        .unwrap();
    let before:Value=sqlx::query_scalar("SELECT product_snapshot FROM price_table_items WHERE tenant_id=$1 AND version_id=$2 AND product_id=$3").bind(tenant).bind(version).bind(valid).fetch_one(&admin).await.unwrap();
    let input = json!({"line":"imported","versionId":version,"destinationState":"SP","taxpayer":false,"discount":{"kind":"percent","value":0},"freightCents":0,"items":[{"productId":valid,"quantity":1}]});
    let original = request(
        &router,
        "POST",
        "/api/v1/commercial/simulate",
        input.clone(),
    )
    .await;
    assert_eq!(original.0, StatusCode::OK, "{}", original.1);
    sqlx::query("UPDATE products SET structure_colors=ARRAY['Azul'],swing_arm_colors=ARRAY['Preto'],upholstery_colors=ARRAY['Café'],finishing_palette='dhz-hammerforce-pro',revision=revision+1 WHERE id=ANY($1)").bind(vec![valid,stale]).execute(&admin).await.unwrap();
    let current = request(
        &router,
        "POST",
        "/api/v1/commercial/simulate",
        input.clone(),
    )
    .await;
    assert_eq!(current, original);
    let general = request(
        &router,
        "GET",
        &format!("/api/v1/products/{valid}"),
        Value::Null,
    )
    .await;
    assert_eq!(general.0, StatusCode::OK);
    assert_eq!(general.1["data"]["revision"], 2);
    let etag = router
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/products/{valid}"))
                .header("x-tenant-id", TENANT)
                .header("authorization", "Bearer editor")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(etag.headers()["etag"], "\"2\"");
    let mixed = json!({"destinationState":"SP","taxpayer":false,"discount":{"kind":"percent","value":0},"freightCents":0,"items":[{"line":"imported","versionId":version,"productId":valid,"quantity":1}]});
    assert_eq!(
        request(&router, "POST", "/api/v1/commercial/mixed/simulate", mixed)
            .await
            .0,
        StatusCode::OK
    );
    let availability = request(
        &router,
        "GET",
        "/api/v1/commercial/tables/imported?destinationState=SP&taxpayer=false",
        Value::Null,
    )
    .await;
    let items = availability.1["data"]["items"].as_array().unwrap();
    assert_eq!(
        items
            .iter()
            .find(|r| r["productId"] == valid.to_string())
            .unwrap()["available"],
        true
    );
    assert_eq!(
        items
            .iter()
            .find(|r| r["productId"] == stale.to_string())
            .unwrap()["available"],
        false
    );
    let mut stale_input = input.clone();
    stale_input["items"][0]["productId"] = json!(stale);
    assert_eq!(
        request(&router, "POST", "/api/v1/commercial/simulate", stale_input)
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(sqlx::query_scalar::<_,Value>("SELECT product_snapshot FROM price_table_items WHERE tenant_id=$1 AND version_id=$2 AND product_id=$3").bind(tenant).bind(version).bind(valid).fetch_one(&admin).await.unwrap(),before);
    sqlx::query("UPDATE product_costs SET revision=revision+1,purchase_cost_cents=purchase_cost_cents+1 WHERE tenant_id=$1 AND product_id=$2").bind(tenant).bind(valid).execute(&admin).await.unwrap();
    assert_eq!(
        request(&router, "POST", "/api/v1/commercial/simulate", input)
            .await
            .0,
        StatusCode::CONFLICT
    );
    cleanup(&admin, app, server, &role).await;
}

#[sqlx::test(migrations = "../../migrations")]
async fn publication_after_colors_uses_price_revision_and_does_not_rewrite_old_versions(
    admin: PgPool,
) {
    let (router, app, server, role) = setup(&admin).await;
    let (old_version, products, _) = super::commercial_table_tests::seed(&admin).await;
    sqlx::raw_sql("INSERT INTO role_permissions(role_id,permission_code) VALUES('99999999-9999-4999-8999-999999999999','platform.company.manage') ON CONFLICT DO NOTHING").execute(&admin).await.unwrap();
    sqlx::query("UPDATE products SET structure_colors=ARRAY['Azul'],finishing_palette='dhz-combined',revision=revision+1 WHERE id=ANY($1)").bind(&products).execute(&admin).await.unwrap();
    let preview = request(
        &router,
        "GET",
        "/api/v1/price-tables/imported/preview",
        Value::Null,
    )
    .await;
    assert_eq!(preview.0, StatusCode::OK, "{}", preview.1);
    for row in preview.1["items"].as_array().unwrap() {
        assert_eq!(row["productRevision"], 1);
    }
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/price-tables/imported/publish")
                .header("x-tenant-id", TENANT)
                .header("authorization", "Bearer editor")
                .header("content-type", "application/json")
                .header("if-match", "\"1\"")
                .header("idempotency-key", Uuid::now_v7().to_string())
                .body(Body::from(
                    json!({"digest":preview.1["digest"]}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 2_000_000).await.unwrap()).unwrap();
    assert_eq!(status, StatusCode::OK, "{body}");
    let version:Uuid=sqlx::query_scalar("SELECT active_price_version_id FROM commercial_settings WHERE tenant_id=$1::uuid AND product_line='imported'").bind(TENANT).fetch_one(&admin).await.unwrap();
    assert_ne!(version, old_version);
    let revisions: Vec<i64> = sqlx::query_scalar(
        "SELECT (product_snapshot->>'revision')::bigint FROM price_table_items WHERE version_id=$1",
    )
    .bind(version)
    .fetch_all(&admin)
    .await
    .unwrap();
    assert_eq!(revisions, vec![1, 1]);
    let quote=request(&router,"POST","/api/v1/commercial/simulate",json!({"line":"imported","versionId":version,"destinationState":"SP","taxpayer":false,"discount":{"kind":"percent","value":0},"freightCents":0,"items":[{"productId":products[0],"quantity":1}]})).await;
    assert_eq!(quote.0, StatusCode::OK, "{}", quote.1);
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM price_table_items WHERE version_id=$1 AND (product_snapshot->>'revision')::bigint=1").bind(old_version).fetch_one(&admin).await.unwrap(),2);
    cleanup(&admin, app, server, &role).await;
}

#[test]
fn explicit_combined_palette_is_accepted_and_unknown_palettes_are_rejected() {
    let mut product:crate::domains::catalog::ProductInput=serde_json::from_value(json!({"sku":"CABLE-TEST","name":"Cable Motion","unit":"UN","basePrice":"100.00","status":"active","finishingPalette":"dhz-combined"})).unwrap();
    assert_eq!(product.validate().unwrap(), 10000);
    product.finishing_palette = Some("invented-palette".into());
    assert!(product.validate().is_err());
}
