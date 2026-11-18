CREATE TABLE finance_collection_batches (
    tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL, reference text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
    created_by text NOT NULL, cancelled_at timestamptz, cancelled_by text, cancel_reason text,
    PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,id,account_id),
    FOREIGN KEY(tenant_id,account_id) REFERENCES financial_accounts(tenant_id,id),
    CHECK ((cancelled_at IS NULL AND cancelled_by IS NULL AND cancel_reason IS NULL) OR
           (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND length(cancel_reason) >= 3))
);
CREATE TABLE finance_collection_batch_items (
    tenant_id uuid NOT NULL, batch_id uuid NOT NULL, receivable_id uuid NOT NULL,
    party_id uuid NOT NULL, party_name text NOT NULL, amount_cents bigint NOT NULL CHECK(amount_cents>0),
    due_on date NOT NULL, released_at timestamptz, PRIMARY KEY(tenant_id,batch_id,receivable_id),
    FOREIGN KEY(tenant_id,batch_id) REFERENCES finance_collection_batches(tenant_id,id),
    FOREIGN KEY(tenant_id,receivable_id) REFERENCES receivables(tenant_id,id),
    FOREIGN KEY(tenant_id,party_id) REFERENCES parties(tenant_id,id)
);
CREATE UNIQUE INDEX finance_collection_batch_reserved ON finance_collection_batch_items(tenant_id,receivable_id) WHERE released_at IS NULL;
CREATE INDEX finance_collection_batch_history ON finance_collection_batches(tenant_id,created_at DESC,id DESC);
ALTER TABLE finance_collection_charges ADD COLUMN batch_id uuid,
    ADD FOREIGN KEY(tenant_id,batch_id,account_id) REFERENCES finance_collection_batches(tenant_id,id,account_id),
    ADD CHECK(batch_id IS NULL OR group_id IS NULL);
CREATE INDEX finance_collection_batch_charges ON finance_collection_charges(tenant_id,batch_id) WHERE batch_id IS NOT NULL;
DO $privileges$
DECLARE tbl text;
BEGIN
 FOREACH tbl IN ARRAY ARRAY['finance_collection_batches','finance_collection_batch_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
    IF EXISTS(SELECT FROM pg_roles WHERE rolname='erp_next_app') THEN
        EXECUTE format('GRANT SELECT,INSERT ON %I TO erp_next_app',tbl);
    END IF;
 END LOOP;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='erp_next_app') THEN
   GRANT UPDATE(cancelled_at,cancelled_by,cancel_reason) ON finance_collection_batches TO erp_next_app;
   GRANT UPDATE(released_at) ON finance_collection_batch_items TO erp_next_app;
 END IF;
END $privileges$;
