CREATE TABLE sales_pipeline_settings (
    tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
    stages jsonb NOT NULL CHECK(jsonb_typeof(stages)='array'),
    revision bigint NOT NULL CHECK(revision>0)
);

CREATE TABLE sales_pipeline_activities (
    tenant_id uuid NOT NULL,
    opportunity_id uuid NOT NULL,
    id uuid NOT NULL,
    kind text NOT NULL CHECK(kind IN ('call','visit','email')),
    subject text NOT NULL CHECK(char_length(subject) BETWEEN 1 AND 240),
    due_date date NOT NULL,
    owner_id uuid NOT NULL REFERENCES identities(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    PRIMARY KEY(tenant_id,opportunity_id,id),
    FOREIGN KEY(tenant_id,opportunity_id) REFERENCES sales_opportunities(tenant_id,id)
);
CREATE INDEX sales_pipeline_activities_owner ON sales_pipeline_activities(tenant_id,owner_id,due_date) WHERE completed_at IS NULL;
CREATE INDEX sales_opportunity_stage_events ON audit_log(tenant_id,entity_id,occurred_at) WHERE entity_type='sales_opportunity' AND details ? 'stage';
CREATE UNIQUE INDEX sales_opportunity_proposal ON sales_opportunities(tenant_id,proposal_id) WHERE proposal_id IS NOT NULL;

DO $$
DECLARE tbl text;
BEGIN
    FOREACH tbl IN ARRAY ARRAY['sales_pipeline_settings','sales_pipeline_activities'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
        EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
    END LOOP;
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='erp_next_app') THEN
        GRANT SELECT,INSERT,UPDATE ON sales_pipeline_settings,sales_pipeline_activities,sales_opportunities TO erp_next_app;
    END IF;
END $$;
