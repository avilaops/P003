CREATE TABLE sales_return_policies (
    tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
    revision bigint NOT NULL CHECK(revision>0),
    window_days integer CHECK(window_days BETWEEN 0 AND 3650),
    approval_above_cents bigint CHECK(approval_above_cents BETWEEN 0 AND 999999999999999),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sales_return_requests (
    tenant_id uuid NOT NULL, id uuid NOT NULL, order_id uuid NOT NULL, lot_id uuid NOT NULL,
    received_id bigint NOT NULL, xml_sha256 text NOT NULL CHECK(xml_sha256 ~ '^[0-9a-f]{64}$'),
    reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 200),
    destination text NOT NULL CHECK(destination IN ('stock','service','discard')),
    amount_cents bigint NOT NULL CHECK(amount_cents>=0),
    policy_revision bigint NOT NULL, requested_by text NOT NULL, requested_at timestamptz NOT NULL DEFAULT now(),
    status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected')),
    decision_by text, decided_at timestamptz, decision_reason text, return_id uuid,
    CHECK ((status='pending')=(decided_at IS NULL) AND (status='pending')=(decision_by IS NULL) AND
           (status='approved')=(return_id IS NOT NULL) AND requested_by IS DISTINCT FROM decision_by),
    PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,lot_id,order_id) REFERENCES sales_invoice_lots(tenant_id,id,order_id),
    FOREIGN KEY(tenant_id,received_id) REFERENCES fiscal_received_nfes(tenant_id,id),
    FOREIGN KEY(tenant_id,return_id,lot_id) REFERENCES sales_partial_returns(tenant_id,id,lot_id)
);
CREATE UNIQUE INDEX sales_one_pending_return ON sales_return_requests(tenant_id,received_id) WHERE status='pending';
CREATE INDEX sales_returns_by_order ON sales_return_requests(tenant_id,order_id,requested_at DESC);
DO $$ DECLARE name text; BEGIN
    FOREACH name IN ARRAY ARRAY['sales_return_policies','sales_return_requests'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
        EXECUTE format($policy$CREATE POLICY tenant_isolation ON %I USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$policy$,name);
        IF EXISTS(SELECT FROM pg_roles WHERE rolname='erp_next_app') THEN
            EXECUTE format('GRANT SELECT,INSERT ON %I TO erp_next_app',name);
        END IF;
    END LOOP;
    IF EXISTS(SELECT FROM pg_roles WHERE rolname='erp_next_app') THEN
        GRANT UPDATE(revision,window_days,approval_above_cents,updated_at) ON sales_return_policies TO erp_next_app;
        GRANT UPDATE(status,decision_by,decided_at,decision_reason,return_id) ON sales_return_requests TO erp_next_app;
    END IF;
END $$;
