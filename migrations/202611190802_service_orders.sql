-- S2 • Ordens de serviço avulsas (fora do fluxo de protocolos de garantia).
CREATE TABLE service_orders (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    number text NOT NULL CHECK (number ~ '^OS-[0-9]{6,}$'),
    customer_id uuid NOT NULL,
    title text NOT NULL CHECK (length(trim(title)) BETWEEN 3 AND 160),
    description text NOT NULL DEFAULT '' CHECK (length(description) <= 4000),
    product_id uuid,
    serial_number text CHECK (serial_number IS NULL OR length(trim(serial_number)) BETWEEN 1 AND 120),
    technician_id uuid,
    warranty_case_id uuid,
    under_warranty boolean NOT NULL DEFAULT false,
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','scheduled','in_progress','completed','cancelled')),
    scheduled_at timestamptz,
    started_at timestamptz,
    completed_at timestamptz,
    sla_due_at timestamptz,
    checklist jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(checklist) = 'array' AND jsonb_array_length(checklist) <= 60),
    signature jsonb,
    labor_cents bigint NOT NULL DEFAULT 0 CHECK (labor_cents >= 0),
    parts_cents bigint NOT NULL DEFAULT 0 CHECK (parts_cents >= 0),
    charge_status text NOT NULL DEFAULT 'none' CHECK (charge_status IN ('none','pending','blocked','issued','waived')),
    charge_ref text,
    charge_message text CHECK (charge_message IS NULL OR length(charge_message) <= 500),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, number),
    CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
    CHECK (status <> 'completed' OR signature IS NOT NULL),
    FOREIGN KEY (tenant_id, customer_id) REFERENCES parties(tenant_id, id),
    FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id),
    FOREIGN KEY (tenant_id, technician_id) REFERENCES staff(tenant_id, id),
    FOREIGN KEY (tenant_id, warranty_case_id) REFERENCES warranty_cases(tenant_id, id)
);
CREATE INDEX service_orders_status ON service_orders(tenant_id, status, updated_at DESC);
CREATE INDEX service_orders_equipment ON service_orders(tenant_id, upper(serial_number)) WHERE serial_number IS NOT NULL;

CREATE TABLE service_order_hours (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, order_id uuid NOT NULL,
    minutes integer NOT NULL CHECK (minutes BETWEEN 1 AND 1440),
    rate_cents bigint NOT NULL CHECK (rate_cents BETWEEN 0 AND 99999999999999),
    note text NOT NULL DEFAULT '' CHECK (length(note) <= 300),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, order_id) REFERENCES service_orders(tenant_id, id)
);
CREATE TABLE service_order_parts (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, order_id uuid NOT NULL, product_id uuid NOT NULL,
    product_name text NOT NULL, sku text,
    quantity_micros bigint NOT NULL CHECK (quantity_micros > 0),
    unit_cents bigint NOT NULL CHECK (unit_cents BETWEEN 0 AND 99999999999999),
    stock_movement_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (tenant_id, stock_movement_id),
    FOREIGN KEY (tenant_id, order_id) REFERENCES service_orders(tenant_id, id),
    FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id),
    FOREIGN KEY (tenant_id, stock_movement_id) REFERENCES stock_movements(tenant_id, id)
);
CREATE TABLE service_order_photos (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, order_id uuid NOT NULL,
    filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 160),
    media_type text NOT NULL CHECK (media_type IN ('image/jpeg','image/png','image/webp')),
    content bytea NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 6000000),
    sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
    caption text NOT NULL DEFAULT '' CHECK (length(caption) <= 200),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, order_id) REFERENCES service_orders(tenant_id, id)
);
CREATE INDEX service_order_hours_order ON service_order_hours(tenant_id, order_id);
CREATE INDEX service_order_parts_order ON service_order_parts(tenant_id, order_id);
CREATE INDEX service_order_photos_order ON service_order_photos(tenant_id, order_id);

DO $$
DECLARE item text;
BEGIN
    FOREACH item IN ARRAY ARRAY['service_orders','service_order_hours','service_order_parts','service_order_photos'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', item);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', item);
        EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)', item);
    END LOOP;
    FOREACH item IN ARRAY ARRAY['service_order_hours','service_order_parts','service_order_photos'] LOOP
        EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_audit_log_changes()', item);
    END LOOP;
END $$;

INSERT INTO permissions(code, description) VALUES
    ('service.orders.read', 'Consultar ordens de serviço, horas, peças e histórico de equipamentos'),
    ('service.orders.manage', 'Abrir, executar, fechar e cobrar ordens de serviço')
ON CONFLICT(code) DO NOTHING;

DO $$ BEGIN
    IF EXISTS(SELECT FROM pg_roles WHERE rolname='erp_next_app') THEN
        GRANT SELECT,INSERT,UPDATE ON service_orders TO erp_next_app;
        GRANT SELECT,INSERT ON service_order_hours,service_order_parts,service_order_photos TO erp_next_app;
    END IF;
END $$;
