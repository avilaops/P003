CREATE TABLE sales_self_return_plans (
    tenant_id uuid NOT NULL,id uuid NOT NULL,order_id uuid NOT NULL,lot_id uuid NOT NULL,
    environment text NOT NULL CHECK(environment IN('production','homologation')),original_key char(44) NOT NULL,
    reason text NOT NULL,destination text NOT NULL CHECK(destination IN('stock','service','discard')),
    submitted_by text NOT NULL,decision_by text,decision_reason text,amount_cents bigint NOT NULL CHECK(amount_cents>=0),
    status text NOT NULL CHECK(status IN('pending','ready','declined','withdrawn','applied','simulated')),
    items jsonb NOT NULL CHECK(jsonb_typeof(items)='array'), return_id uuid, received_id bigint,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,id),
    FOREIGN KEY(tenant_id,lot_id,order_id) REFERENCES sales_invoice_lots(tenant_id,id,order_id),
    FOREIGN KEY(tenant_id,return_id) REFERENCES sales_partial_returns(tenant_id,id),
    FOREIGN KEY(tenant_id,received_id) REFERENCES fiscal_received_nfes(tenant_id,id),
    UNIQUE(tenant_id,received_id)
);
CREATE INDEX sales_own_return_orders ON sales_self_return_plans(tenant_id,order_id,environment,created_at);
CREATE UNIQUE INDEX sales_own_return_pending_lot ON sales_self_return_plans(tenant_id,lot_id) WHERE status IN('pending','ready');
ALTER TABLE sales_self_return_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_self_return_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sales_self_return_plans USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE FUNCTION sales_pending_return_balance(company uuid,sale uuid,line integer,except_plan uuid DEFAULT NULL)
RETURNS TABLE(quantity numeric,amount numeric) LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum((i->>'quantityMicros')::numeric),0),coalesce(sum((i->>'valueCents')::numeric),0)
  FROM sales_self_return_plans p CROSS JOIN LATERAL jsonb_array_elements(p.items) i
  WHERE p.tenant_id=company AND p.order_id=sale AND p.environment='production' AND p.status IN('pending','ready')
    AND (i->>'lineNumber')::int=line AND (except_plan IS NULL OR p.id<>except_plan)
$$;
ALTER TABLE fiscal_received_nfes ADD COLUMN own_return_document_id uuid,
  ADD FOREIGN KEY(tenant_id,own_return_document_id) REFERENCES fiscal_nfe_documents(tenant_id,id),
  ADD UNIQUE(tenant_id,own_return_document_id);
ALTER TABLE fiscal_nfe_drafts DROP CONSTRAINT fiscal_nfe_drafts_return_source_check,
  ADD CONSTRAINT fiscal_nfe_drafts_return_source_check CHECK((source_return_id IS NULL)=(source_return_kind IS NULL)
    AND (source_return_kind IS NULL OR source_return_kind IN('sale_cancellation','purchase_reversal','sale_partial_return')));
ALTER TABLE fiscal_nfe_documents DROP CONSTRAINT fiscal_nfe_documents_return_source_check,
  ADD CONSTRAINT fiscal_nfe_documents_return_source_check CHECK((source_return_id IS NULL)=(source_return_kind IS NULL)
    AND (source_return_kind IS NULL OR source_return_kind IN('sale_cancellation','purchase_reversal','sale_partial_return')));
DO $$ BEGIN IF EXISTS(SELECT FROM pg_roles WHERE rolname='erp_next_app') THEN
  GRANT SELECT,INSERT,UPDATE(status,decision_by,decision_reason,received_id,return_id,updated_at) ON sales_self_return_plans TO erp_next_app;
END IF; END $$;
CREATE FUNCTION reject_own_return_purchase() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT FROM fiscal_received_nfes n WHERE n.tenant_id=NEW.tenant_id AND n.id=NEW.received_nfe_id AND n.own_return_document_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Entrada própria de devolução não pertence a compra' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER own_return_purchase_guard BEFORE INSERT ON fiscal_received_purchase_links FOR EACH ROW EXECUTE FUNCTION reject_own_return_purchase();
