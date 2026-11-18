CREATE TABLE warranty_settlement_reviews (
  tenant_id uuid NOT NULL,approval_id uuid NOT NULL,case_id uuid NOT NULL,reviewer_id uuid NOT NULL REFERENCES identities(id),
  reference text NOT NULL CHECK(length(trim(reference)) BETWEEN 3 AND 160), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,approval_id),
  FOREIGN KEY(tenant_id,case_id) REFERENCES warranty_cases(tenant_id,id),
  FOREIGN KEY(tenant_id,approval_id) REFERENCES warranty_approvals(tenant_id,id)
);
ALTER TABLE warranty_settlement_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE warranty_settlement_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON warranty_settlement_reviews USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE TRIGGER warranty_review_immutable BEFORE UPDATE OR DELETE ON warranty_settlement_reviews FOR EACH ROW EXECUTE FUNCTION reject_audit_log_changes();
CREATE TABLE warranty_settlements (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, case_id uuid NOT NULL,
    order_id uuid NOT NULL, line_number integer NOT NULL, customer_id uuid NOT NULL, product_id uuid NOT NULL,
    approval_id uuid, rma_id uuid, service_order_id uuid, supplier_id uuid,
    source_credit_id uuid, receivable_id uuid, account_entry_id uuid, stock_movement_id uuid,
    kind text NOT NULL CHECK(kind IN ('credit','apply_credit','refund','exchange','intake','repair_return','scrap','supplier_cash','supplier_stock')),
    amount_cents bigint CHECK(amount_cents BETWEEN 1 AND 99999999999999),
    quantity_micros bigint CHECK(quantity_micros BETWEEN 1 AND 999999999999999999),
    occurred_on date NOT NULL, reference text NOT NULL CHECK(length(trim(reference)) BETWEEN 3 AND 160),
    origin jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(tenant_id,id), UNIQUE(tenant_id,approval_id), UNIQUE(tenant_id,rma_id),
    UNIQUE(tenant_id,stock_movement_id), UNIQUE(tenant_id,account_entry_id), UNIQUE(tenant_id,case_id,kind,reference),
    FOREIGN KEY(tenant_id,case_id) REFERENCES warranty_cases(tenant_id,id),
    FOREIGN KEY(tenant_id,order_id,line_number) REFERENCES sales_order_lines(tenant_id,order_id,line_number),
    FOREIGN KEY(tenant_id,customer_id) REFERENCES parties(tenant_id,id),
    FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),
    FOREIGN KEY(tenant_id,approval_id) REFERENCES warranty_approvals(tenant_id,id),
    FOREIGN KEY(tenant_id,rma_id) REFERENCES warranty_rmas(tenant_id,id),
    FOREIGN KEY(tenant_id,service_order_id) REFERENCES warranty_service_orders(tenant_id,id),
    FOREIGN KEY(tenant_id,supplier_id) REFERENCES parties(tenant_id,id),
    FOREIGN KEY(tenant_id,source_credit_id) REFERENCES warranty_settlements(tenant_id,id),
    FOREIGN KEY(tenant_id,receivable_id) REFERENCES receivables(tenant_id,id),
    FOREIGN KEY(tenant_id,account_entry_id) REFERENCES financial_account_entries(tenant_id,id),
    FOREIGN KEY(tenant_id,stock_movement_id) REFERENCES stock_movements(tenant_id,id),
    CHECK ((approval_id IS NOT NULL)=(kind IN ('credit','refund','exchange'))),
    CHECK ((rma_id IS NOT NULL)=(kind IN ('supplier_cash','supplier_stock'))),
    CHECK ((supplier_id IS NOT NULL)=(rma_id IS NOT NULL)),
    CHECK ((source_credit_id IS NOT NULL)=(kind='apply_credit')),
    CHECK ((receivable_id IS NOT NULL)=(kind='apply_credit')),
    CHECK ((service_order_id IS NOT NULL)=(kind='repair_return')),
    CHECK ((account_entry_id IS NOT NULL)=(kind IN ('supplier_cash','refund'))),
    CHECK ((stock_movement_id IS NOT NULL)=(kind IN ('supplier_stock','exchange'))),
    CHECK ((amount_cents IS NOT NULL)=(kind IN ('credit','apply_credit','refund','supplier_cash'))),
    CHECK ((quantity_micros IS NOT NULL)=(amount_cents IS NULL))
);
CREATE INDEX warranty_settlements_by_origin ON warranty_settlements(tenant_id,order_id,line_number,kind);
CREATE INDEX warranty_settlements_credit_applications ON warranty_settlements(tenant_id,source_credit_id) WHERE source_credit_id IS NOT NULL;
CREATE INDEX warranty_settlements_case_date ON warranty_settlements(tenant_id,case_id,created_at);
ALTER TABLE warranty_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE warranty_settlements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON warranty_settlements USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE TRIGGER warranty_settlements_immutable BEFORE UPDATE OR DELETE ON warranty_settlements FOR EACH ROW EXECUTE FUNCTION reject_audit_log_changes();
DO $$ BEGIN
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='erp_next_app') THEN
    GRANT SELECT,INSERT ON warranty_settlement_reviews,warranty_settlements,financial_account_entries TO erp_next_app;
    GRANT SELECT (id,tenant_id,entity_id,action,identity_id,details,occurred_at) ON audit_log TO erp_next_app;
    GRANT SELECT ON receivable_payments,financial_accounts,pos_sessions TO erp_next_app;
    GRANT SELECT,UPDATE ON receivables TO erp_next_app;
  END IF;
END $$;
