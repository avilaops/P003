CREATE TABLE finance_operation_reviews (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    party_id uuid NOT NULL,
    side text NOT NULL CHECK (side IN ('receivable','payable')),
    request jsonb NOT NULL,
    requested_by text NOT NULL,
    requested_at timestamptz NOT NULL DEFAULT now(),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
    decided_by text,
    decided_at timestamptz,
    decision_reason text,
    operation_id uuid,
    UNIQUE (tenant_id,id),
    FOREIGN KEY (tenant_id,party_id) REFERENCES parties(tenant_id,id),
    FOREIGN KEY (tenant_id,operation_id) REFERENCES finance_operations(tenant_id,id),
    CHECK (decided_by IS NULL OR decided_by<>requested_by),
    CHECK ((status='pending')=(decided_by IS NULL)),
    CHECK ((status='approved')=(operation_id IS NOT NULL))
);
CREATE INDEX finance_review_party ON finance_operation_reviews(tenant_id,party_id,status);
ALTER TABLE finance_operation_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_operation_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON finance_operation_reviews USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
DO $grant$ BEGIN
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='erp_next_app') THEN GRANT SELECT,INSERT,UPDATE ON finance_operation_reviews TO erp_next_app; END IF;
END $grant$;
