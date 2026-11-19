-- L2 • Ávila Envios: contratação de frete por expedição, etiqueta e eventos de rastreio.
CREATE TABLE logistics_freight_contracts (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    shipment_id uuid NOT NULL,
    provider text NOT NULL CHECK (char_length(provider) BETWEEN 2 AND 60),
    provider_reference text NOT NULL CHECK (char_length(provider_reference) BETWEEN 1 AND 120),
    service_code text NOT NULL CHECK (char_length(service_code) BETWEEN 1 AND 60),
    service_name text NOT NULL CHECK (char_length(service_name) BETWEEN 1 AND 120),
    carrier_name text NOT NULL CHECK (char_length(carrier_name) BETWEEN 2 AND 120),
    price_cents bigint NOT NULL CHECK (price_cents >= 0),
    delivery_days integer NOT NULL CHECK (delivery_days BETWEEN 0 AND 365),
    tracking_code text CHECK (tracking_code IS NULL OR char_length(tracking_code) BETWEEN 4 AND 60),
    quote_snapshot jsonb NOT NULL CHECK (jsonb_typeof(quote_snapshot) = 'object'),
    status text NOT NULL DEFAULT 'contracted' CHECK (status IN ('contracted', 'labeled', 'in_transit', 'delivered', 'cancelled')),
    label_format text CHECK (label_format IS NULL OR label_format IN ('pdf', 'zpl')),
    label_code text CHECK (label_code IS NULL OR char_length(label_code) BETWEEN 1 AND 120),
    label_content bytea CHECK (label_content IS NULL OR octet_length(label_content) <= 2097152),
    labeled_at timestamptz,
    cancelled_at timestamptz,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, provider, provider_reference),
    FOREIGN KEY (tenant_id, shipment_id) REFERENCES logistics_shipments(tenant_id, id),
    CHECK ((label_content IS NULL) = (label_format IS NULL) AND (label_content IS NULL) = (labeled_at IS NULL)),
    CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL)
);
-- Uma contratação ativa por expedição; canceladas ficam no histórico.
CREATE UNIQUE INDEX logistics_freight_contracts_active_idx ON logistics_freight_contracts(tenant_id, shipment_id) WHERE status <> 'cancelled';
CREATE INDEX logistics_freight_contracts_list_idx ON logistics_freight_contracts(tenant_id, status, updated_at DESC, id DESC);

CREATE TABLE logistics_freight_events (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    contract_id uuid NOT NULL,
    provider_event_id text NOT NULL CHECK (char_length(provider_event_id) BETWEEN 1 AND 120),
    occurred_at timestamptz NOT NULL,
    status text NOT NULL CHECK (status IN ('posted', 'in_transit', 'out_for_delivery', 'delivered', 'exception')),
    description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 300),
    location text CHECK (location IS NULL OR char_length(location) <= 200),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, contract_id, provider_event_id),
    FOREIGN KEY (tenant_id, contract_id) REFERENCES logistics_freight_contracts(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX logistics_freight_events_idx ON logistics_freight_events(tenant_id, contract_id, occurred_at);

ALTER TABLE logistics_freight_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_freight_contracts FORCE ROW LEVEL SECURITY;
CREATE POLICY logistics_freight_contracts_isolation ON logistics_freight_contracts
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE logistics_freight_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_freight_events FORCE ROW LEVEL SECURITY;
CREATE POLICY logistics_freight_events_isolation ON logistics_freight_events
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

INSERT INTO permissions(code, description) VALUES
    ('logistics.freight.read', 'Consultar envios contratados, etiquetas e rastreio'),
    ('logistics.freight.manage', 'Cotar e contratar frete, gerar etiqueta, atualizar rastreio e cancelar envios')
ON CONFLICT (code) DO NOTHING;
