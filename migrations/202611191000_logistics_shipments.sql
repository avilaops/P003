-- L1 • Expedição e romaneio: A separar → Separado → Conferido → Expedido → Entregue.
CREATE TABLE logistics_shipments (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    order_id uuid NOT NULL,
    checkout_id uuid,
    status text NOT NULL DEFAULT 'to_separate' CHECK (status IN ('to_separate', 'separated', 'checked', 'shipped', 'delivered')),
    carrier_name text CHECK (carrier_name IS NULL OR char_length(btrim(carrier_name)) BETWEEN 2 AND 120),
    vehicle_plate text CHECK (vehicle_plate IS NULL OR char_length(btrim(vehicle_plate)) BETWEEN 4 AND 12),
    driver_name text CHECK (driver_name IS NULL OR char_length(btrim(driver_name)) BETWEEN 2 AND 120),
    tracking_code text CHECK (tracking_code IS NULL OR char_length(btrim(tracking_code)) BETWEEN 4 AND 60),
    manifest_number text,
    shipped_at timestamptz,
    delivered_at timestamptz,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, order_id),
    UNIQUE (tenant_id, manifest_number),
    FOREIGN KEY (tenant_id, order_id) REFERENCES sales_orders(tenant_id, id),
    FOREIGN KEY (tenant_id, checkout_id) REFERENCES logistics_checkouts(tenant_id, id),
    CHECK (status NOT IN ('shipped', 'delivered') OR (shipped_at IS NOT NULL AND manifest_number IS NOT NULL AND carrier_name IS NOT NULL)),
    CHECK (status <> 'delivered' OR delivered_at IS NOT NULL)
);
CREATE INDEX logistics_shipments_tenant_status_idx ON logistics_shipments(tenant_id, status, updated_at DESC, id DESC);

CREATE TABLE logistics_shipment_events (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    shipment_id uuid NOT NULL,
    status text NOT NULL,
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, shipment_id) REFERENCES logistics_shipments(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX logistics_shipment_events_idx ON logistics_shipment_events(tenant_id, shipment_id, created_at);

ALTER TABLE logistics_shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_shipments FORCE ROW LEVEL SECURITY;
CREATE POLICY logistics_shipments_isolation ON logistics_shipments
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE logistics_shipment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_shipment_events FORCE ROW LEVEL SECURITY;
CREATE POLICY logistics_shipment_events_isolation ON logistics_shipment_events
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

INSERT INTO permissions(code, description) VALUES
    ('logistics.shipments.read', 'Consultar expedições e romaneios da empresa'),
    ('logistics.shipments.manage', 'Separar, conferir, expedir e confirmar entrega de pedidos')
ON CONFLICT (code) DO NOTHING;
