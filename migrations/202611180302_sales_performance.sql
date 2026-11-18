CREATE TABLE sales_targets (
 tenant_id uuid NOT NULL, seller_id uuid NOT NULL, month date NOT NULL CHECK (extract(day FROM month)=1),
 product_line text NOT NULL CHECK(product_line IN ('national','imported','catalog')),
 basis text NOT NULL CHECK(basis IN ('accepted','invoiced')),
 amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 99999999999999),
 quantity_micros bigint NOT NULL CHECK(quantity_micros > 0),
 alert_bps integer NOT NULL DEFAULT 8000 CHECK(alert_bps BETWEEN 0 AND 10000),
 revision bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,seller_id,month,product_line),
 FOREIGN KEY(tenant_id,seller_id) REFERENCES staff(tenant_id,id)
);
CREATE TABLE sales_acceptance_margins (
 tenant_id uuid NOT NULL, order_id uuid NOT NULL, accepted_at timestamptz NOT NULL,
 managerial jsonb, net_sale_cents bigint, PRIMARY KEY(tenant_id,order_id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES sales_orders(tenant_id,id)
);
CREATE FUNCTION capture_sales_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO sales_acceptance_margins(tenant_id,order_id,accepted_at,managerial,net_sale_cents)
 SELECT NEW.tenant_id,NEW.id,statement_timestamp(),q.private_snapshot->'director',(q.public_snapshot#>>'{sale,netSaleCents}')::bigint
 FROM (SELECT 1) s LEFT JOIN commercial_order_quotes q ON q.tenant_id=NEW.tenant_id AND q.order_id=NEW.id
 ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER sales_acceptance_metrics AFTER UPDATE OF status ON sales_orders FOR EACH ROW
 WHEN(OLD.status='draft' AND NEW.status IN ('accepted','confirmed')) EXECUTE FUNCTION capture_sales_acceptance();
-- Dates on old documents are anchored to an actual acceptance or direct confirmation.
INSERT INTO sales_acceptance_margins(tenant_id,order_id,accepted_at,managerial,net_sale_cents)
SELECT o.tenant_id,o.id,min(a.occurred_at),q.private_snapshot->'director',(q.public_snapshot#>>'{sale,netSaleCents}')::bigint
FROM sales_orders o JOIN audit_log a ON a.tenant_id=o.tenant_id AND a.entity_type='sales_order' AND a.entity_id=o.id::text
 AND a.action IN ('order.accepted','order.confirmed')
LEFT JOIN commercial_order_quotes q ON (q.tenant_id,q.order_id)=(o.tenant_id,o.id)
GROUP BY o.tenant_id,o.id,q.private_snapshot,q.public_snapshot;

CREATE TABLE sales_invoice_costs (
 tenant_id uuid NOT NULL, invoice_id uuid NOT NULL, order_id uuid NOT NULL, line_number integer NOT NULL,
 quantity_micros bigint NOT NULL CHECK(quantity_micros>0), cost_cents bigint, PRIMARY KEY(tenant_id,invoice_id,line_number),
 FOREIGN KEY(tenant_id,invoice_id) REFERENCES fiscal_nfe_documents(tenant_id,id),
 FOREIGN KEY(tenant_id,order_id,line_number) REFERENCES sales_order_lines(tenant_id,order_id,line_number)
);
-- The weighted unit acquisition cost comes from physical purchase receipts already recorded when the invoice was issued.
-- Quantities without a purchase receipt retain a NULL cost.
CREATE FUNCTION snapshot_sales_invoice_costs(p_tenant uuid,p_invoice uuid) RETURNS void LANGUAGE sql AS $$
 INSERT INTO sales_invoice_costs(tenant_id,invoice_id,order_id,line_number,quantity_micros,cost_cents)
 SELECT d.tenant_id,d.id,s.order_id,s.line_number,COALESCE(li.quantity_micros,s.quantity_micros),
        round(COALESCE(li.quantity_micros,s.quantity_micros)*c.amount/nullif(c.quantity,0))::bigint
 FROM fiscal_nfe_documents d LEFT JOIN sales_invoice_lots lot ON (lot.tenant_id,lot.draft_id)=(d.tenant_id,d.id)
 JOIN sales_order_lines s ON s.tenant_id=d.tenant_id AND s.order_id=COALESCE(lot.order_id,d.source_order_id)
 LEFT JOIN sales_invoice_lot_items li ON li.tenant_id=lot.tenant_id AND li.lot_id=lot.id AND li.line_number=s.line_number
 LEFT JOIN LATERAL (SELECT sum(l.amount_cents)::numeric AS amount,sum(l.quantity_micros)::numeric AS quantity
    FROM purchase_receipt_lines l JOIN purchase_receipts r ON (r.tenant_id,r.id)=(l.tenant_id,l.receipt_id)
    WHERE l.tenant_id=s.tenant_id AND l.product_id=s.product_id AND l.unit=s.unit AND r.created_at<=d.issued_at::timestamptz
      AND r.occurred_on<=(d.issued_at::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date) c ON true
 WHERE d.tenant_id=p_tenant AND d.id=p_invoice AND d.model=55 AND d.environment='production' AND d.status='authorized'
 AND (lot.id IS NULL OR NOT lot.withdrawn AND li.line_number IS NOT NULL)
 ON CONFLICT DO NOTHING
$$;
CREATE FUNCTION capture_sales_invoice_costs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM snapshot_sales_invoice_costs(NEW.tenant_id,NEW.id);
 RETURN NEW;
END $$;
CREATE TRIGGER sales_invoice_cost_metrics AFTER INSERT OR UPDATE OF status ON fiscal_nfe_documents FOR EACH ROW
 WHEN(NEW.status='authorized' AND NEW.environment='production' AND NEW.model=55) EXECUTE FUNCTION capture_sales_invoice_costs();
SELECT snapshot_sales_invoice_costs(tenant_id,id) FROM fiscal_nfe_documents WHERE status='authorized' AND environment='production' AND model=55;
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['sales_targets','sales_acceptance_margins','sales_invoice_costs'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format($policy$CREATE POLICY tenant_isolation ON %I USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$policy$,relation);
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='erp_next_app') THEN
   EXECUTE format('GRANT SELECT,INSERT ON %I TO erp_next_app',relation);
  END IF;
 END LOOP;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='erp_next_app') THEN GRANT UPDATE ON sales_targets TO erp_next_app; END IF;
END $$;
CREATE TRIGGER lock_sales_acceptance_margin BEFORE UPDATE OR DELETE ON sales_acceptance_margins FOR EACH ROW EXECUTE FUNCTION reject_audit_log_changes();
CREATE TRIGGER lock_sales_invoice_cost BEFORE UPDATE OR DELETE ON sales_invoice_costs FOR EACH ROW EXECUTE FUNCTION reject_audit_log_changes();
