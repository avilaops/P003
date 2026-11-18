CREATE TABLE sales_payment_terms (
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 id uuid NOT NULL,
 revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
 name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
 entry_bps integer NOT NULL CHECK (entry_bps BETWEEN 0 AND 10000),
 due_days integer[] NOT NULL CHECK (cardinality(due_days) BETWEEN 0 AND 120),
 method_id uuid NOT NULL,
 active boolean NOT NULL DEFAULT true,
 PRIMARY KEY (tenant_id,id),
 FOREIGN KEY (tenant_id,method_id) REFERENCES payment_methods(tenant_id,id),
 UNIQUE (tenant_id,name)
);

CREATE TABLE sales_customer_policies (
 tenant_id uuid NOT NULL,
 customer_id uuid NOT NULL,
 revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
 credit_limit_cents bigint CHECK (credit_limit_cents BETWEEN 0 AND 99999999999999),
 valid_until date,
 blocked boolean NOT NULL DEFAULT false,
 overdue_days integer CHECK (overdue_days BETWEEN 0 AND 3650),
 payment_term_id uuid,
 price_list_id uuid,
 PRIMARY KEY (tenant_id,customer_id),
 FOREIGN KEY (tenant_id,customer_id) REFERENCES parties(tenant_id,id),
 FOREIGN KEY (tenant_id,payment_term_id) REFERENCES sales_payment_terms(tenant_id,id),
 FOREIGN KEY (tenant_id,price_list_id) REFERENCES price_lists(tenant_id,id)
);

CREATE TABLE sales_channel_prices (
 tenant_id uuid NOT NULL,
 channel text NOT NULL CHECK (length(btrim(channel)) BETWEEN 1 AND 80),
 price_list_id uuid NOT NULL,
 revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
 PRIMARY KEY (tenant_id,channel),
 FOREIGN KEY (tenant_id,price_list_id) REFERENCES price_lists(tenant_id,id)
);

CREATE TABLE sales_credit_reviews (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 order_id uuid NOT NULL,
 order_revision bigint NOT NULL,
 policy_revision bigint NOT NULL,
 exposure_cents numeric NOT NULL,
 reasons text[] NOT NULL,
 requested_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','cancelled')),
 decided_by text,
 decision_reason text,
 decided_at timestamptz,
 FOREIGN KEY (tenant_id,order_id) REFERENCES sales_orders(tenant_id,id),
 CHECK(decided_by IS NULL OR decided_by<>requested_by)
);
CREATE UNIQUE INDEX sales_credit_review_pending ON sales_credit_reviews(tenant_id,order_id) WHERE status='pending';

CREATE TABLE sales_approval_routing (
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 level text NOT NULL CHECK (level IN ('manager','director','credit')),
 due_hours integer NOT NULL DEFAULT 48 CHECK (due_hours BETWEEN 1 AND 2160),
 substitute_id uuid,
 substitute_until date,
 revision bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,level),
 FOREIGN KEY(substitute_id) REFERENCES identities(id),
 CHECK ((substitute_id IS NULL) = (substitute_until IS NULL))
);
ALTER TABLE sales_order_checkouts ADD COLUMN payment_term_snapshot jsonb;
ALTER TABLE sales_proposal_versions ADD COLUMN requested_by text;
ALTER TABLE sales_proposal_versions ADD COLUMN payment_term_snapshot jsonb;
ALTER TABLE sales_order_lines ADD COLUMN price_origin jsonb;
ALTER TABLE sales_proposal_lines ADD COLUMN price_origin jsonb;

DO $$
DECLARE relation text;
BEGIN
 FOREACH relation IN ARRAY ARRAY['sales_payment_terms','sales_customer_policies','sales_channel_prices','sales_credit_reviews','sales_approval_routing'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',relation);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='erp_next_app') THEN
   EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO erp_next_app',relation);
  END IF;
 END LOOP;
END $$;

