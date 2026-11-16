use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::Value;
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

const TENANT: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "22222222-2222-4222-8222-222222222222";

async fn read(router: &Router, path: &str, subject: &str, tenant: &str) -> (StatusCode, Value) {
    let result = router
        .clone()
        .oneshot(
            Request::builder()
                .uri(path)
                .header("authorization", format!("Bearer {subject}"))
                .header("x-tenant-id", tenant)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = result.status();
    let bytes = to_bytes(result.into_body(), 1_000_000).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

// This catches counting only the page, sorting creation instead of update,
// exposing another tenant, or allowing a reader to edit the listed records.
#[sqlx::test(migrations = "../../migrations")]
async fn sales_lists_count_all_drafts_and_sort_real_updates_with_tenant_permissions(admin: PgPool) {
    let (router, app, server, role) = super::company_tests::setup(&admin).await;
    sqlx::raw_sql("INSERT INTO role_permissions(role_id,permission_code) SELECT 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,code FROM permissions WHERE code IN ('sales.orders.read','sales.proposals.read');
        INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) SELECT id,id,'fisica','Cliente','52998224725',true,false,'active' FROM tenants;")
        .execute(&admin).await.unwrap();
    let mut expected = Vec::new();
    for tenant in [TENANT, OTHER] {
        for day in 1..=9_i32 {
            let id = Uuid::now_v7();
            let status = if day == 9 { "confirmed" } else { "draft" };
            let mut tx = admin.begin().await.unwrap();
            sqlx::query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status,created_at,updated_at) VALUES($1,$2::uuid,$2::uuid,'Cliente','52998224725','2027-01-01',100,$3,'2026-01-20'::timestamptz - $4::int * interval '1 day','2026-02-01'::timestamptz + $4::int * interval '1 day')")
                .bind(id).bind(tenant).bind(status).bind(day).execute(&mut *tx).await.unwrap();
            sqlx::query("INSERT INTO sales_proposals(id,tenant_id,created_at,updated_at) VALUES($1,$2::uuid,'2026-01-20'::timestamptz - $3::int * interval '1 day','2026-02-01'::timestamptz + $3::int * interval '1 day')")
                .bind(id).bind(tenant).bind(day).execute(&mut *tx).await.unwrap();
            sqlx::query("INSERT INTO sales_proposal_versions(tenant_id,proposal_id,version,customer_id,customer_name,customer_tax_id,valid_until,payment_terms,delivery_terms,amount_cents,status,created_by,sent_at) VALUES($1::uuid,$2,1,$1::uuid,'Cliente','52998224725','2100-01-01','À vista','Retirada',100,$3,'fixture',CASE WHEN $3='sent' THEN now() END)")
                .bind(tenant).bind(id).bind(if day == 9 { "sent" } else { "draft" }).execute(&mut *tx).await.unwrap();
            tx.commit().await.unwrap();
            if tenant == TENANT {
                expected.push(id.to_string());
            }
        }
    }
    sqlx::raw_sql("INSERT INTO commercial_settings(tenant_id,product_line,parameters,revision) VALUES('11111111-1111-4111-8111-111111111111','imported','{}',1);
        INSERT INTO price_table_versions(id,tenant_id,product_line,version,settings_revision,policy_snapshot,calculator_version,digest,published_by) VALUES('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','11111111-1111-4111-8111-111111111111','imported',1,1,'{}','list-query-test',repeat('a',64),'33333333-3333-4333-8333-333333333333');")
        .execute(&admin).await.unwrap();
    sqlx::query("INSERT INTO order_pricing_snapshots(tenant_id,order_id,version_id,snapshot,needs_approval) VALUES($1::uuid,$2,'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','{}',false)")
        .bind(TENANT).bind(Uuid::parse_str(&expected[7]).unwrap()).execute(&admin).await.unwrap();
    sqlx::query("INSERT INTO commercial_order_quotes(tenant_id,order_id,price_version_id,public_snapshot,private_snapshot,approval_rules,approval_status,requires_director,created_by) VALUES($1::uuid,$2,'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','{}','{}','{}','not_required',false,'33333333-3333-4333-8333-333333333333')")
        .bind(TENANT).bind(Uuid::parse_str(&expected[6]).unwrap()).execute(&admin).await.unwrap();
    for kind in ["orders", "proposals"] {
        let uri = format!("/api/v1/{kind}?status=draft&sort=updated&limit=5");
        let (status, list) = read(&router, &uri, "reader", TENANT).await;
        assert_eq!(status, StatusCode::OK, "{kind}: {list}");
        assert_eq!(list["total"], 8);
        assert_eq!(list["canEdit"], false);
        let rows = list["data"].as_array().unwrap();
        assert_eq!(rows.len(), 5);
        for (row, id) in rows.iter().zip(expected[..8].iter().rev()) {
            assert_eq!(row["id"], *id);
            assert!(row["updatedAt"].as_str().unwrap().starts_with("2026-02-"));
            if kind == "orders" {
                assert_eq!(
                    row["pricingOrigin"],
                    *id == expected[7] || *id == expected[6]
                );
            }
        }
        let (_, tail) = read(&router, &format!("{uri}&offset=5"), "reader", TENANT).await;
        assert_eq!(tail["total"], 8);
        assert_eq!(tail["data"].as_array().unwrap().len(), 3);
        let (_, original) = read(
            &router,
            &format!("/api/v1/{kind}?limit=1"),
            "reader",
            TENANT,
        )
        .await;
        assert_eq!(original["data"][0]["id"], expected[0]);
        let (_, recent) = read(
            &router,
            &format!("/api/v1/{kind}?sort=updated&limit=1"),
            "reader",
            TENANT,
        )
        .await;
        assert_eq!(recent["data"][0]["id"], expected[8]);
        for (subject, tenant) in [("reader", OTHER), ("disabled", TENANT)] {
            assert_eq!(
                read(&router, &uri, subject, tenant).await.0,
                StatusCode::FORBIDDEN
            );
        }
        for query in ["sort=invalid", "status=invalid"] {
            assert_eq!(
                read(
                    &router,
                    &format!("/api/v1/{kind}?{query}"),
                    "reader",
                    TENANT
                )
                .await
                .0,
                StatusCode::UNPROCESSABLE_ENTITY
            );
        }
    }
    super::company_tests::cleanup(&admin, app, server, &role).await;
}
