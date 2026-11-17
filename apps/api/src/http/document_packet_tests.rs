use sqlx::PgPool;

const TENANT: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "22222222-2222-4222-8222-222222222222";

// Catches a partial schema, missing FORCE RLS, or a package implementation
// that cannot make persisted position the single source of ordering truth.
#[sqlx::test(migrations = "../../migrations")]
async fn document_engine_schema_has_all_tenant_safe_tables(admin: PgPool) {
    let expected = [
        "document_packet_items",
        "document_packets",
        "document_template_versions",
        "document_templates",
        "render_jobs",
        "rendered_documents",
    ];
    let rows: Vec<(String, bool, bool)> = sqlx::query_as(
        "SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='document_engine'
           AND c.relkind='r'
         ORDER BY c.relname",
    )
    .fetch_all(&admin)
    .await
    .unwrap();

    assert_eq!(
        rows.iter().map(|row| row.0.as_str()).collect::<Vec<_>>(),
        expected
    );
    assert!(rows.iter().all(|row| row.1 && row.2));

    let unique_position: bool = sqlx::query_scalar(
        "SELECT EXISTS (
           SELECT FROM pg_constraint c
            WHERE c.conrelid='document_engine.document_packet_items'::regclass
              AND c.contype='u'
              AND ARRAY(
                SELECT a.attname::text
                  FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum
                 ORDER BY k.ord
              ) = ARRAY['tenant_id','packet_id','position']
         )",
    )
    .fetch_one(&admin)
    .await
    .unwrap();
    assert!(
        unique_position,
        "packet positions must be unique within each tenant and packet"
    );
}

async fn seed_packet_graph(admin: &PgPool) {
    sqlx::raw_sql(
        r#"
        INSERT INTO tenants(id,legal_name,tax_id) VALUES
          ('11111111-1111-4111-8111-111111111111','Empresa A','04252011000110'),
          ('22222222-2222-4222-8222-222222222222','Empresa B','52998224725');
        INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status)
          SELECT id,id,'fisica','Cliente','52998224725',true,false,'active' FROM tenants;
        INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status)
          SELECT id,id,id,'Cliente','52998224725','2027-01-01',100,'draft' FROM tenants;

        INSERT INTO document_engine.document_templates
          (id,tenant_id,document_type,name,created_by) VALUES
          ('aaaaaaaa-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','order','Pedido','editor'),
          ('aaaaaaaa-0000-4000-8000-000000000002','22222222-2222-4222-8222-222222222222','order','Pedido','editor');
        INSERT INTO document_engine.document_template_versions
          (id,tenant_id,template_id,version,engine,content,content_sha256,created_by) VALUES
          ('bbbbbbbb-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',1,'typst','pedido',repeat('a',64),'editor'),
          ('bbbbbbbb-0000-4000-8000-000000000002','22222222-2222-4222-8222-222222222222','aaaaaaaa-0000-4000-8000-000000000002',1,'typst','pedido',repeat('b',64),'editor');
        INSERT INTO document_engine.render_jobs
          (id,tenant_id,template_version_id,source_kind,source_id,source_revision,idempotency_key) VALUES
          ('cccccccc-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','bbbbbbbb-0000-4000-8000-000000000001','order','11111111-1111-4111-8111-111111111111',1,'tenant-a-order-1'),
          ('cccccccc-0000-4000-8000-000000000002','22222222-2222-4222-8222-222222222222','bbbbbbbb-0000-4000-8000-000000000002','order','22222222-2222-4222-8222-222222222222',1,'tenant-b-order-1');
        INSERT INTO document_engine.rendered_documents
          (id,tenant_id,render_job_id,template_version_id,document_type,source_kind,source_id,source_revision,storage_key,media_type,byte_size,content_sha256,source_snapshot) VALUES
          ('dddddddd-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','cccccccc-0000-4000-8000-000000000001','bbbbbbbb-0000-4000-8000-000000000001','order','order','11111111-1111-4111-8111-111111111111',1,'tenant-a/order.pdf','application/pdf',10,repeat('c',64),'{}'),
          ('dddddddd-0000-4000-8000-000000000002','22222222-2222-4222-8222-222222222222','cccccccc-0000-4000-8000-000000000002','bbbbbbbb-0000-4000-8000-000000000002','order','order','22222222-2222-4222-8222-222222222222',1,'tenant-b/order.pdf','application/pdf',10,repeat('d',64),'{}');
        INSERT INTO document_engine.document_packets(id,tenant_id,order_id,created_by)
          VALUES('eeeeeeee-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111','editor');
        "#,
    )
    .execute(admin)
    .await
    .unwrap();
}

// Catches invalid positions, tenant-crossing references, and mutations that
// would change the evidence after a packet was sealed.
#[sqlx::test(migrations = "../../migrations")]
async fn packet_positions_and_sealed_evidence_are_database_invariants(admin: PgPool) {
    seed_packet_graph(&admin).await;

    let invalid_position = sqlx::query("INSERT INTO document_engine.document_packet_items(id,tenant_id,packet_id,document_id,section,position,added_by) VALUES(gen_random_uuid(),$1::uuid,'eeeeeeee-0000-4000-8000-000000000001','dddddddd-0000-4000-8000-000000000001','order',0,'editor')")
        .bind(TENANT).execute(&admin).await.unwrap_err();
    assert_eq!(
        invalid_position
            .as_database_error()
            .unwrap()
            .code()
            .as_deref(),
        Some("23514")
    );

    let cross_tenant = sqlx::query("INSERT INTO document_engine.document_packet_items(id,tenant_id,packet_id,document_id,section,position,added_by) VALUES(gen_random_uuid(),$1::uuid,'eeeeeeee-0000-4000-8000-000000000001','dddddddd-0000-4000-8000-000000000002','order',1,'editor')")
        .bind(TENANT).execute(&admin).await.unwrap_err();
    assert_eq!(
        cross_tenant.as_database_error().unwrap().code().as_deref(),
        Some("23503")
    );

    sqlx::query("UPDATE document_engine.document_packets SET status='sealed',sealed_at=now() WHERE tenant_id=$1::uuid AND id='eeeeeeee-0000-4000-8000-000000000001'")
        .bind(TENANT).execute(&admin).await.unwrap();
    let reopen = sqlx::query("UPDATE document_engine.document_packets SET status='draft',sealed_at=NULL WHERE tenant_id=$1::uuid AND id='eeeeeeee-0000-4000-8000-000000000001'")
        .bind(TENANT).execute(&admin).await.unwrap_err();
    assert_eq!(
        reopen.as_database_error().unwrap().code().as_deref(),
        Some("42501")
    );
    let append = sqlx::query("INSERT INTO document_engine.document_packet_items(id,tenant_id,packet_id,document_id,section,position,added_by) VALUES(gen_random_uuid(),$1::uuid,'eeeeeeee-0000-4000-8000-000000000001','dddddddd-0000-4000-8000-000000000001','order',1,'editor')")
        .bind(TENANT).execute(&admin).await.unwrap_err();
    assert_eq!(
        append.as_database_error().unwrap().code().as_deref(),
        Some("42501")
    );

    let other_tenant_document: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM document_engine.rendered_documents WHERE tenant_id=$1::uuid",
    )
    .bind(OTHER)
    .fetch_one(&admin)
    .await
    .unwrap();
    assert_eq!(other_tenant_document, 1);
}
