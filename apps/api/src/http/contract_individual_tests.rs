//! Synthetic records only. Real PostgreSQL and a role without RLS bypass.
use sqlx::{PgPool, Postgres, Transaction, postgres::PgPoolOptions};
use uuid::Uuid;

const TABLES: [&str; 11] = [
    "contract_signature_envelopes",
    "contract_signature_participants",
    "contract_signature_states",
    "contract_signature_documents",
    "contract_signature_revisions",
    "contract_signature_heads",
    "contract_signature_evidence",
    "contract_signature_uploads",
    "contract_signature_jobs",
    "contract_signature_grants",
    "contract_signature_sessions",
];

async fn fixture(admin: &PgPool) -> (PgPool, Uuid, Uuid, Uuid, Uuid, String) {
    let tenant = Uuid::now_v7();
    let other = Uuid::now_v7();
    let customer = Uuid::now_v7();
    let order = Uuid::now_v7();
    let legacy_contract = Uuid::now_v7();
    let contract = Uuid::now_v7();
    sqlx::query("INSERT INTO tenants(id,legal_name,tax_id) VALUES($1,'Synthetic company','04252011000110'),($2,'Other synthetic company','52998224725')")
        .bind(tenant).bind(other).execute(admin).await.unwrap();
    sqlx::query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$2,'fisica','Synthetic participant','52998224725',true,false,'active')")
        .bind(customer).bind(tenant).execute(admin).await.unwrap();
    sqlx::query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$3,'Synthetic participant','52998224725','2026-12-01',100,'draft')")
        .bind(order).bind(tenant).bind(customer).execute(admin).await.unwrap();
    sqlx::query("INSERT INTO commercial_contracts(id,tenant_id,customer_id,order_id,template_id,template_name,template_snapshot,snapshot,recipients,fields,fingerprint,status) VALUES($1,$2,$3,$4,1,'Synthetic','{}','{}','[]','{}','synthetic','created')")
        .bind(legacy_contract).bind(tenant).bind(customer).bind(order).execute(admin).await.unwrap();
    sqlx::query("INSERT INTO commercial_contracts(id,tenant_id,customer_id,order_id,template_id,template_name,template_snapshot,snapshot,recipients,fields,fingerprint,status,signature_policy) VALUES($1,$2,$3,$4,1,'Synthetic ICP','{}','{}','[]','{}','synthetic-icp','creation_requested','icp_each_participant')")
        .bind(contract).bind(tenant).bind(customer).bind(order).execute(admin).await.unwrap();
    let role = format!("icp_test_{}", Uuid::now_v7().simple());
    sqlx::raw_sql(&format!("CREATE ROLE {role} NOLOGIN NOSUPERUSER NOBYPASSRLS; GRANT USAGE ON SCHEMA public TO {role}; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO {role}"))
        .execute(admin).await.unwrap();
    let assumed = role.clone();
    let application = PgPoolOptions::new()
        .max_connections(4)
        .after_connect(move |conn, _| {
            let command = format!("SET ROLE {assumed}");
            Box::pin(async move {
                sqlx::query(&command).execute(conn).await?;
                Ok(())
            })
        })
        .connect_with(admin.connect_options().as_ref().clone())
        .await
        .unwrap();
    (application, tenant, other, contract, Uuid::now_v7(), role)
}

async fn tenant_tx(pool: &PgPool, tenant: Uuid) -> Transaction<'_, Postgres> {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.tenant_id',$1,true)")
        .bind(tenant.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    tx
}

async fn envelope(tx: &mut Transaction<'_, Postgres>, tenant: Uuid, contract: Uuid, id: Uuid) {
    sqlx::query("INSERT INTO contract_signature_envelopes(tenant_id,id,contract_id,policy,policy_sha256,trust_bundle_sha256,participant_count) VALUES($1,$2,$3,'icp_each_participant',repeat('a',64),repeat('b',64),2)")
        .bind(tenant).bind(id).bind(contract).execute(&mut **tx).await.unwrap();
}

async fn finish(admin: &PgPool, app: PgPool, role: String) {
    app.close().await;
    sqlx::raw_sql(&format!("DROP OWNED BY {role}; DROP ROLE {role}"))
        .execute(admin)
        .await
        .unwrap();
}

#[sqlx::test(migrations = "../../migrations")]
async fn contract_individual_schema_is_forced_rls_and_legacy_is_not_upgraded(admin: PgPool) {
    let (app, tenant, other, contract, id, role) = fixture(&admin).await;
    let policy: String = sqlx::query_scalar("SELECT signature_policy FROM commercial_contracts WHERE tenant_id=$1 AND fingerprint='synthetic'").bind(tenant).fetch_one(&admin).await.unwrap();
    assert_eq!(policy, "legacy_docuseal");
    for table in TABLES {
        let flags: (bool, bool) = sqlx::query_as(
            "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass",
        )
        .bind(table)
        .fetch_one(&admin)
        .await
        .unwrap();
        assert_eq!(flags, (true, true), "{table}");
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&app)
            .await
            .unwrap();
        assert_eq!(count, 0, "no tenant must mean no rows: {table}");
    }
    let bypass: bool = sqlx::query_scalar(
        "SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user",
    )
    .fetch_one(&app)
    .await
    .unwrap();
    assert!(!bypass);
    let mut tx = tenant_tx(&app, tenant).await;
    envelope(&mut tx, tenant, contract, id).await;
    tx.commit().await.unwrap();
    let mut crossed = tenant_tx(&app, other).await;
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM contract_signature_envelopes WHERE id=$1")
            .bind(id)
            .fetch_one(&mut *crossed)
            .await
            .unwrap();
    assert_eq!(count, 0);
    let denied = sqlx::query("INSERT INTO contract_signature_states(tenant_id,envelope_id,phase) VALUES($1,$2,'portal_pending')").bind(tenant).bind(id).execute(&mut *crossed).await.unwrap_err();
    assert_eq!(
        denied.as_database_error().unwrap().code().as_deref(),
        Some("42501")
    );
    crossed.rollback().await.unwrap();
    // Even a role with all table privileges may not relabel historical validity.
    let mut tx = tenant_tx(&app, tenant).await;
    let denied = sqlx::query("UPDATE commercial_contracts SET signature_policy='icp_each_participant' WHERE tenant_id=$1 AND fingerprint='synthetic'").bind(tenant).execute(&mut *tx).await.unwrap_err();
    assert_eq!(
        denied.as_database_error().unwrap().code().as_deref(),
        Some("42501")
    );
    tx.rollback().await.unwrap();
    finish(&admin, app, role).await;
}

#[sqlx::test(migrations = "../../migrations")]
async fn contract_individual_snapshots_and_evidence_are_immutable_and_tenant_bound(admin: PgPool) {
    let (app, tenant, other, contract, id, role) = fixture(&admin).await;
    let mut tx = tenant_tx(&app, tenant).await;
    envelope(&mut tx, tenant, contract, id).await;
    tx.commit().await.unwrap();
    for (column, value) in [
        ("policy", "'legacy_docuseal'"),
        ("participant_count", "3"),
        ("policy_sha256", "repeat('c',64)"),
    ] {
        let mut tx = tenant_tx(&app, tenant).await;
        assert!(
            sqlx::query(&format!(
                "UPDATE contract_signature_envelopes SET {column}={value} WHERE id=$1"
            ))
            .bind(id)
            .execute(&mut *tx)
            .await
            .is_err()
        );
        tx.rollback().await.unwrap();
    }
    let mut tx = tenant_tx(&app, tenant).await;
    assert!(
        sqlx::query("DELETE FROM contract_signature_envelopes WHERE id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await
            .is_err()
    );
    tx.rollback().await.unwrap();
    // Composite FK rejects a real envelope from a different tenant, even when RLS permits the new row.
    let mut tx = tenant_tx(&app, other).await;
    let crossed = sqlx::query("INSERT INTO contract_signature_states(tenant_id,envelope_id,phase) VALUES($1,$2,'portal_pending')").bind(other).bind(id).execute(&mut *tx).await.unwrap_err();
    assert_eq!(
        crossed.as_database_error().unwrap().code().as_deref(),
        Some("23503")
    );
    tx.rollback().await.unwrap();
    let immutable = [
        "contract_signature_envelopes",
        "contract_signature_participants",
        "contract_signature_documents",
        "contract_signature_revisions",
        "contract_signature_evidence",
    ];
    for table in immutable {
        let guarded: i64 = sqlx::query_scalar("SELECT count(*) FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal AND (tgtype & 16)=16 AND (tgtype & 8)=8")
            .bind(table).fetch_one(&admin).await.unwrap();
        assert_eq!(guarded, 1, "append-only snapshot: {table}");
    }
    finish(&admin, app, role).await;
}

#[sqlx::test(migrations = "../../migrations")]
async fn contract_individual_operational_bounds_and_blob_hashes_are_enforced(admin: PgPool) {
    let (app, tenant, _, contract, id, role) = fixture(&admin).await;
    let mut tx = tenant_tx(&app, tenant).await;
    envelope(&mut tx, tenant, contract, id).await;
    sqlx::query("INSERT INTO contract_signature_states(tenant_id,envelope_id,phase) VALUES($1,$2,'portal_pending')").bind(tenant).bind(id).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    for assignment in [
        "stored_bytes=-1",
        "stored_bytes=1073741825",
        "current_participant=11",
        "revision=0",
        "phase='portal_completed'",
    ] {
        let mut tx = tenant_tx(&app, tenant).await;
        assert!(
            sqlx::query(&format!(
                "UPDATE contract_signature_states SET {assignment} WHERE envelope_id=$1"
            ))
            .bind(id)
            .execute(&mut *tx)
            .await
            .is_err(),
            "{assignment}"
        );
        tx.rollback().await.unwrap();
    }
    let mut tx = tenant_tx(&app, tenant).await;
    let corrupt = sqlx::query("INSERT INTO contract_signature_documents(tenant_id,envelope_id,id,position,provider_document_id,sha256,content) VALUES($1,$2,$3,1,'synthetic',repeat('a',64),'%PDF-synthetic'::bytea)")
        .bind(tenant).bind(id).bind(Uuid::now_v7()).execute(&mut *tx).await.unwrap_err();
    assert_eq!(
        corrupt.as_database_error().unwrap().code().as_deref(),
        Some("23514")
    );
    tx.rollback().await.unwrap();
    finish(&admin, app, role).await;
}

#[sqlx::test(migrations = "../../migrations")]
async fn contract_individual_every_snapshot_rejects_update_and_delete_even_by_owner(admin: PgPool) {
    sqlx::raw_sql(include_str!(
        "../../tests/fixtures/contract-individual-snapshots.sql"
    ))
    .execute(&admin)
    .await
    .unwrap();
}
