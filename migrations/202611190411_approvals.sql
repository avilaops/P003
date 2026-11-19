-- Motor genérico de aprovação por alçada (D04/C3). Compartilhado por compras, vendas e descontos.
-- Uma regra exige aprovação quando o valor do documento supera o limite (e o centro de custo /
-- categoria coincidem, quando informados). Cada regra aplicável vira uma etapa decidida por um papel.
INSERT INTO permissions(code,description) VALUES
 ('approvals.rules.manage','Configurar as regras de alçada de aprovação'),
 ('approvals.decide','Consultar e decidir as aprovações pendentes da própria alçada')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE approval_rules (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 document_type text NOT NULL CHECK (document_type IN ('purchase','purchase_request','purchase_entry','sale','discount')),
 name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 3 AND 120),
 threshold_cents bigint NOT NULL CHECK (threshold_cents BETWEEN 0 AND 99999999999999),
 cost_center_id uuid,
 category_id uuid,
 approver_role_id uuid NOT NULL REFERENCES roles(id),
 active boolean NOT NULL DEFAULT true,
 revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id,id),
 FOREIGN KEY (tenant_id,cost_center_id) REFERENCES financial_cost_centers(tenant_id,id),
 FOREIGN KEY (tenant_id,category_id) REFERENCES financial_categories(tenant_id,id)
);
CREATE INDEX approval_rules_lookup_idx ON approval_rules(tenant_id,document_type,threshold_cents) WHERE active;

CREATE TABLE approval_requests (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 document_type text NOT NULL CHECK (document_type IN ('purchase','purchase_request','purchase_entry','sale','discount')),
 document_id text NOT NULL CHECK (char_length(document_id) BETWEEN 1 AND 80),
 amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 0 AND 99999999999999),
 cost_center_id uuid,
 category_id uuid,
 summary text NOT NULL CHECK (char_length(btrim(summary)) BETWEEN 1 AND 300),
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
 requested_by uuid NOT NULL REFERENCES identities(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 decided_at timestamptz,
 UNIQUE (tenant_id,id),
 CHECK ((status='pending') = (decided_at IS NULL))
);
CREATE UNIQUE INDEX approval_requests_one_pending ON approval_requests(tenant_id,document_type,document_id) WHERE status='pending';
CREATE INDEX approval_requests_document_idx ON approval_requests(tenant_id,document_type,document_id,created_at DESC);

CREATE TABLE approval_steps (
 tenant_id uuid NOT NULL,
 request_id uuid NOT NULL,
 rule_id uuid NOT NULL,
 rule_name text NOT NULL,
 threshold_cents bigint NOT NULL,
 approver_role_id uuid NOT NULL REFERENCES roles(id),
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
 decided_by uuid REFERENCES identities(id),
 reason text CHECK (reason IS NULL OR char_length(btrim(reason)) BETWEEN 3 AND 500),
 decided_at timestamptz,
 PRIMARY KEY (tenant_id,request_id,rule_id),
 FOREIGN KEY (tenant_id,request_id) REFERENCES approval_requests(tenant_id,id),
 FOREIGN KEY (tenant_id,rule_id) REFERENCES approval_rules(tenant_id,id),
 CHECK ((status IN ('approved','rejected')) = (decided_by IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE INDEX approval_steps_pending_idx ON approval_steps(tenant_id,approver_role_id) WHERE status='pending';

DO $$
DECLARE relation text;
BEGIN
 FOREACH relation IN ARRAY ARRAY['approval_rules','approval_requests','approval_steps'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',relation);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='erp_next_app') THEN
   EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO erp_next_app',relation);
  END IF;
 END LOOP;
END $$;

-- Compra acima da alçada fica aguardando aprovação: não segue ao fornecedor nem é recebida.
ALTER TABLE purchase_orders DROP CONSTRAINT purchase_orders_status_check;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_status_check
 CHECK (status IN ('draft','awaiting_approval','confirmed','partially_received','received','cancelled','closed'));
