ALTER TABLE purchase_order_lines ADD COLUMN warehouse_id uuid,
  ADD FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id);

-- A partial receipt keeps its own immutable location. The line stores the choice
-- for the next receipt only, and the generic location trigger validates the site.
CREATE FUNCTION stock_purchase_location() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE selected uuid;
BEGIN
  SELECT l.warehouse_id INTO selected FROM purchase_receipts r JOIN purchase_order_lines l
    ON (l.tenant_id,l.order_id)=(r.tenant_id,r.order_id)
    JOIN stock_location_settings s ON s.tenant_id=r.tenant_id AND s.enabled
    WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.source_purchase_receipt_id AND l.product_id=NEW.product_id;
  IF selected IS NOT NULL THEN
    IF NEW.warehouse_id IS NOT NULL AND NEW.warehouse_id<>selected THEN
      RAISE EXCEPTION USING ERRCODE='P4101',MESSAGE='Depósito divergente do pedido de compra';
    END IF;
    NEW.warehouse_id:=selected;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assign_purchase_warehouse BEFORE INSERT ON stock_movements FOR EACH ROW
  WHEN (NEW.source_purchase_receipt_id IS NOT NULL) EXECUTE FUNCTION stock_purchase_location();

CREATE FUNCTION reset_draft_stock_locations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.enabled AND NOT NEW.enabled THEN
    UPDATE sales_order_lines l SET warehouse_id=NULL FROM sales_orders o
      WHERE (o.tenant_id,o.id)=(l.tenant_id,l.order_id) AND o.tenant_id=NEW.tenant_id AND o.status IN ('draft','accepted') AND l.warehouse_id IS NOT NULL;
    UPDATE purchase_order_lines l SET warehouse_id=NULL FROM purchase_orders o
      WHERE (o.tenant_id,o.id)=(l.tenant_id,l.order_id) AND o.tenant_id=NEW.tenant_id AND o.status IN ('draft','confirmed','partially_received')
      AND l.received_micros<l.quantity_micros AND l.warehouse_id IS NOT NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reset_draft_stock_locations AFTER UPDATE OF enabled ON stock_location_settings FOR EACH ROW EXECUTE FUNCTION reset_draft_stock_locations();
