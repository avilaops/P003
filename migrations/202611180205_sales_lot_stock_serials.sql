-- An invoicing lot consumes only the unshipped reservation in its warehouse.
CREATE OR REPLACE VIEW stock_location_reservations WITH (security_invoker=true) AS
SELECT l.tenant_id,l.product_id,coalesce(l.warehouse_id,c.opening_id) AS warehouse_id,l.order_id,
       (l.quantity_micros-order_line_delivered(l.tenant_id,l.order_id,l.line_number))::bigint AS quantity_micros
FROM sales_order_lines l JOIN sales_orders o ON (o.tenant_id,o.id)=(l.tenant_id,l.order_id)
JOIN stock_location_settings c ON c.tenant_id=l.tenant_id
WHERE o.status='confirmed' AND l.quantity_micros>order_line_delivered(l.tenant_id,l.order_id,l.line_number);

ALTER TABLE stock_movements ADD COLUMN sales_invoice_lot_id uuid, ADD COLUMN sales_partial_return_id uuid,
  ADD FOREIGN KEY(tenant_id,sales_invoice_lot_id,source_order_id) REFERENCES sales_invoice_lots(tenant_id,id,order_id),
  ADD FOREIGN KEY(tenant_id,sales_partial_return_id,sales_invoice_lot_id) REFERENCES sales_partial_returns(tenant_id,id,lot_id),
  ADD CHECK(sales_invoice_lot_id IS NULL OR source_order_id IS NOT NULL),
  ADD CHECK(sales_partial_return_id IS NULL OR (direction='receipt' AND sales_invoice_lot_id IS NOT NULL));
CREATE UNIQUE INDEX stock_sale_return_product ON stock_movements(tenant_id,sales_partial_return_id,product_id) WHERE sales_partial_return_id IS NOT NULL;
ALTER TABLE sales_partial_return_items ADD COLUMN serial_numbers text[];
ALTER TABLE sales_return_requests ADD COLUMN serial_selection jsonb NOT NULL DEFAULT '[]';
ALTER TABLE stock_serial_events ADD COLUMN sales_partial_return_id uuid,
  ADD FOREIGN KEY(tenant_id,sales_partial_return_id) REFERENCES sales_partial_returns(tenant_id,id);

CREATE VIEW sales_delivered_lot_serials WITH (security_invoker=true) AS
SELECT s.tenant_id,s.product_id,s.serial,s.warehouse_id,l.order_id,l.id AS lot_id
FROM stock_serials s JOIN stock_movements m ON (m.tenant_id,m.id)=(s.tenant_id,s.last_movement_id)
JOIN sales_invoice_lots l ON (l.tenant_id,l.order_id)=(m.tenant_id,m.source_order_id)
WHERE s.status='sold' AND m.direction='issue' AND l.environment='production' AND l.delivered_at IS NOT NULL
  AND (m.sales_invoice_lot_id=l.id OR (m.sales_invoice_lot_id IS NULL AND l.legacy_full AND NOT EXISTS (
    SELECT FROM sales_invoice_lots other JOIN fiscal_nfe_documents d ON (d.tenant_id,d.id)=(other.tenant_id,other.draft_id)
    WHERE other.tenant_id=l.tenant_id AND other.order_id=l.order_id AND other.id<>l.id AND other.environment='production'
      AND other.legacy_full AND d.status='authorized')));
DO $$ BEGIN IF EXISTS(SELECT FROM pg_roles WHERE rolname='erp_next_app') THEN
  GRANT SELECT ON sales_delivered_lot_serials TO erp_next_app;
END IF; END $$;

-- Generic receipts create new serials. A partial sale return restores an existing sold unit.
DROP TRIGGER track_serials ON stock_movements;
CREATE CONSTRAINT TRIGGER track_serials AFTER INSERT ON stock_movements DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW.sales_partial_return_id IS NULL) EXECUTE FUNCTION track_stock_serial_movement();

CREATE FUNCTION stock_sale_return_serials() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source record; movement stock_movements%ROWTYPE; unit text; tracked stock_serials%ROWTYPE; target text;
BEGIN
  SELECT s.product_id,l.order_id,l.legacy_full,r.destination INTO STRICT source
    FROM sales_invoice_lots l JOIN sales_order_lines s ON (s.tenant_id,s.order_id)=(l.tenant_id,l.order_id)
    JOIN sales_partial_returns r ON (r.tenant_id,r.id,r.lot_id)=(l.tenant_id,NEW.return_id,l.id)
    WHERE l.tenant_id=NEW.tenant_id AND l.id=NEW.lot_id AND s.line_number=NEW.line_number;
  IF NOT EXISTS(SELECT FROM stock_serial_products WHERE tenant_id=NEW.tenant_id AND product_id=source.product_id) THEN
    IF cardinality(NEW.serial_numbers)>0 THEN RAISE EXCEPTION USING ERRCODE='P4101',MESSAGE='Produto sem controle de série'; END IF;
    RETURN NULL;
  END IF;
  IF cardinality(coalesce(NEW.serial_numbers,'{}'))::bigint*1000000<>NEW.quantity_micros THEN
    RAISE EXCEPTION USING ERRCODE='P4101',MESSAGE='Identifique cada unidade devolvida pela série';
  END IF;
  target:=CASE source.destination WHEN 'stock' THEN 'available' WHEN 'service' THEN 'service' ELSE 'written_off' END;
  IF source.destination='stock' THEN
    SELECT * INTO movement FROM stock_movements WHERE tenant_id=NEW.tenant_id AND sales_partial_return_id=NEW.return_id AND product_id=source.product_id;
    IF NOT FOUND OR movement.quantity_micros<>NEW.quantity_micros OR movement.serial_numbers IS DISTINCT FROM NEW.serial_numbers THEN
      RAISE EXCEPTION USING ERRCODE='P4101',MESSAGE='Movimento e séries divergem da devolução';
    END IF;
  END IF;
  FOREACH unit IN ARRAY NEW.serial_numbers LOOP
    SELECT s.* INTO tracked FROM stock_serials s JOIN sales_delivered_lot_serials sold USING(tenant_id,product_id,serial)
      WHERE sold.tenant_id=NEW.tenant_id AND sold.product_id=source.product_id AND sold.serial=unit AND sold.lot_id=NEW.lot_id
        AND (movement.id IS NULL OR movement.warehouse_id=sold.warehouse_id) FOR UPDATE OF s;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P4101',MESSAGE='Série não pertence ao lote entregue ou já foi devolvida'; END IF;
    UPDATE stock_serials SET status=target,last_movement_id=movement.id WHERE tenant_id=NEW.tenant_id AND product_id=source.product_id AND serial=unit;
    INSERT INTO stock_serial_events(tenant_id,product_id,serial,warehouse_id,status,movement_id,order_id,sales_partial_return_id)
      VALUES(NEW.tenant_id,source.product_id,unit,tracked.warehouse_id,target,movement.id,source.order_id,NEW.return_id);
  END LOOP;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER stock_sale_return_serials AFTER INSERT ON sales_partial_return_items DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION stock_sale_return_serials();

CREATE FUNCTION stock_sale_return_movement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT FROM sales_partial_return_items i JOIN sales_partial_returns r ON (r.tenant_id,r.id,r.lot_id)=(i.tenant_id,i.return_id,i.lot_id)
    JOIN sales_order_lines s ON (s.tenant_id,s.order_id,s.line_number)=(i.tenant_id,NEW.source_order_id,i.line_number)
    WHERE i.tenant_id=NEW.tenant_id AND i.return_id=NEW.sales_partial_return_id AND i.lot_id=NEW.sales_invoice_lot_id
      AND s.product_id=NEW.product_id AND r.destination='stock' AND NEW.quantity_micros=i.quantity_micros
      AND NEW.serial_numbers IS NOT DISTINCT FROM i.serial_numbers) THEN
    RAISE EXCEPTION USING ERRCODE='P4101',MESSAGE='Movimento de devolução sem linha física correspondente';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER stock_sale_return_movement AFTER INSERT ON stock_movements DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW.sales_partial_return_id IS NOT NULL) EXECUTE FUNCTION stock_sale_return_movement();
