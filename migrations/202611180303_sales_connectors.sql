CREATE TABLE sales_connectors (
 tenant_id uuid NOT NULL, code text NOT NULL CHECK(code ~ '^[a-z0-9][a-z0-9_-]{0,47}$'),
 name text NOT NULL, service_key_id uuid NOT NULL, enabled boolean NOT NULL,
 revision bigint NOT NULL DEFAULT 1, PRIMARY KEY(tenant_id,code), UNIQUE(tenant_id,service_key_id),
 FOREIGN KEY(tenant_id,service_key_id) REFERENCES service_api_keys(tenant_id,id)
);
CREATE TABLE sales_channel_listings (
 tenant_id uuid NOT NULL, id uuid NOT NULL, channel text NOT NULL, product_id uuid NOT NULL, external_ref text NOT NULL,
 title text NOT NULL, revision bigint NOT NULL DEFAULT 1,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','paused')),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,channel,external_ref),
 FOREIGN KEY(tenant_id,channel) REFERENCES sales_connectors(tenant_id,code),
 FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id)
);
CREATE TABLE sales_channel_deliveries (
 tenant_id uuid NOT NULL, id uuid NOT NULL, listing_id uuid NOT NULL, action text NOT NULL CHECK(action IN ('publish','sync','pause')),
 payload jsonb NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','failed')),
 confirmation text, created_at timestamptz NOT NULL DEFAULT now(), confirmed_at timestamptz,
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,listing_id) REFERENCES sales_channel_listings(tenant_id,id)
);
CREATE UNIQUE INDEX sales_listing_pending ON sales_channel_deliveries(tenant_id,listing_id) WHERE status='pending';
CREATE TABLE sales_channel_inbox (
 tenant_id uuid NOT NULL, channel text NOT NULL, event_id text NOT NULL, external_number text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('order','cancel','return')), digest text NOT NULL, import_id uuid,
 return_id uuid, received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,channel,event_id),
 FOREIGN KEY(tenant_id,channel) REFERENCES sales_connectors(tenant_id,code),
 FOREIGN KEY(tenant_id,import_id) REFERENCES sales_order_imports(tenant_id,id),
 FOREIGN KEY(tenant_id,return_id) REFERENCES sales_partial_returns(tenant_id,id)
);
CREATE UNIQUE INDEX sales_channel_return_reconciled ON sales_channel_inbox(tenant_id,return_id) WHERE return_id IS NOT NULL;
CREATE INDEX sales_channel_inbox_reference ON sales_channel_inbox(tenant_id,channel,external_number);
DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['sales_connectors','sales_channel_listings','sales_channel_deliveries','sales_channel_inbox'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
  EXECUTE format($policy$CREATE POLICY tenant_isolation ON %I USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$policy$,tbl);
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='erp_next_app') THEN EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO erp_next_app',tbl); END IF;
 END LOOP;
END $$;

