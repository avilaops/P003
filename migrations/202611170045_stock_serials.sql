CREATE TABLE stock_serial_products (
    tenant_id uuid NOT NULL, product_id uuid NOT NULL, enabled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,product_id), FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id)
);
CREATE TABLE stock_serials (
    tenant_id uuid NOT NULL, product_id uuid NOT NULL, serial text NOT NULL CHECK (serial=btrim(serial) AND length(serial) BETWEEN 1 AND 120),
    warehouse_id uuid NOT NULL, status text NOT NULL CHECK(status IN ('available','reserved','sold','service','written_off','in_transit')),
    reserved_order_id uuid, last_movement_id uuid,
    PRIMARY KEY(tenant_id,product_id,serial),
    FOREIGN KEY(tenant_id,product_id) REFERENCES stock_serial_products(tenant_id,product_id),
    FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id),
    FOREIGN KEY(tenant_id,reserved_order_id) REFERENCES sales_orders(tenant_id,id),
    FOREIGN KEY(tenant_id,last_movement_id) REFERENCES stock_movements(tenant_id,id),
    CHECK ((status='reserved')=(reserved_order_id IS NOT NULL))
);
CREATE INDEX stock_serial_lookup ON stock_serials(tenant_id,serial);
CREATE TABLE stock_serial_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL, product_id uuid NOT NULL,
    serial text NOT NULL, warehouse_id uuid NOT NULL, status text NOT NULL, movement_id uuid,
    order_id uuid, pos_sale_id uuid, warranty_id uuid, occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY(tenant_id,product_id,serial) REFERENCES stock_serials(tenant_id,product_id,serial),
    FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id),
    FOREIGN KEY(tenant_id,movement_id) REFERENCES stock_movements(tenant_id,id),
    FOREIGN KEY(tenant_id,order_id) REFERENCES sales_orders(tenant_id,id),
    FOREIGN KEY(tenant_id,pos_sale_id) REFERENCES pos_sales(tenant_id,id),
    FOREIGN KEY(tenant_id,warranty_id) REFERENCES warranty_cases(tenant_id,id)
);
CREATE UNIQUE INDEX stock_serial_movement ON stock_serial_events(tenant_id,movement_id,serial) WHERE movement_id IS NOT NULL;
CREATE INDEX stock_serial_history ON stock_serial_events(tenant_id,product_id,serial,id DESC);
CREATE TRIGGER immutable_serial_event BEFORE UPDATE OR DELETE ON stock_serial_events FOR EACH ROW EXECUTE FUNCTION reject_audit_log_changes();

CREATE TABLE stock_serial_assignments (
    tenant_id uuid NOT NULL, product_id uuid NOT NULL, kind text NOT NULL CHECK (kind IN ('sale','purchase','production','pos','count')),
    document_id uuid NOT NULL, direction text NOT NULL CHECK(direction IN ('receipt','issue')), serials text[] NOT NULL,
    revision integer NOT NULL DEFAULT 1, PRIMARY KEY(tenant_id,product_id,kind,document_id,direction),
    FOREIGN KEY(tenant_id,product_id) REFERENCES stock_serial_products(tenant_id,product_id)
);
ALTER TABLE stock_movements ADD COLUMN serial_numbers text[];
DO $$
DECLARE rel text;
BEGIN
    FOREACH rel IN ARRAY ARRAY['stock_serial_products','stock_serials','stock_serial_events','stock_serial_assignments'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',rel);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',rel);
        EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',rel);
    END LOOP;
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='erp_next_app') THEN
        GRANT SELECT,INSERT ON stock_serial_products,stock_serial_events TO erp_next_app;
        GRANT USAGE ON SEQUENCE stock_serial_events_id_seq TO erp_next_app;
        GRANT SELECT,INSERT,UPDATE ON stock_serials,stock_serial_assignments TO erp_next_app;
    END IF;
END $$;

CREATE FUNCTION reserve_stock_serials() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item record; numbers text[]; changed bigint;
BEGIN
    IF OLD.status=NEW.status THEN RETURN NEW; END IF;
    IF NEW.status='confirmed' THEN
        FOR item IN SELECT l.* FROM sales_order_lines l JOIN stock_serial_products p USING(tenant_id,product_id)
            WHERE l.tenant_id=NEW.tenant_id AND l.order_id=NEW.id ORDER BY l.product_id LOOP
            SELECT serials INTO numbers FROM stock_serial_assignments WHERE tenant_id=NEW.tenant_id AND product_id=item.product_id
                AND kind='sale' AND document_id=NEW.id AND direction='issue';
            IF cardinality(coalesce(numbers,'{}'))::bigint*1000000<>item.quantity_micros THEN
                RAISE EXCEPTION USING ERRCODE='P4101',MESSAGE='Informe uma série por unidade antes de reservar o pedido';
            END IF;
            WITH reserved AS (UPDATE stock_serials SET status='reserved',reserved_order_id=NEW.id
                WHERE tenant_id=NEW.tenant_id AND product_id=item.product_id AND warehouse_id=item.warehouse_id
                    AND status='available' AND serial=ANY(numbers) RETURNING *)
                INSERT INTO stock_serial_events(tenant_id,product_id,serial,warehouse_id,status,order_id)
                SELECT tenant_id,product_id,serial,warehouse_id,status,NEW.id FROM reserved;
            GET DIAGNOSTICS changed = ROW_COUNT;
            IF changed<>cardinality(numbers) THEN RAISE EXCEPTION USING ERRCODE='P4101',MESSAGE='Série indisponível no depósito do pedido'; END IF;
        END LOOP;
    ELSIF OLD.status='confirmed' AND NEW.status<>'completed' THEN
        WITH released AS (UPDATE stock_serials SET status='available',reserved_order_id=NULL WHERE tenant_id=NEW.tenant_id AND reserved_order_id=NEW.id RETURNING *)
            INSERT INTO stock_serial_events(tenant_id,product_id,serial,warehouse_id,status,order_id)
            SELECT tenant_id,product_id,serial,warehouse_id,status,NEW.id FROM released;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER reserve_serials AFTER UPDATE OF status ON sales_orders FOR EACH ROW EXECUTE FUNCTION reserve_stock_serials();

-- Some document writers append the warranty or adjustment reference later in the
-- same transaction. Reconcile at commit, after both document and location exist.
CREATE FUNCTION track_stock_serial_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE numbers text[]; serial_no text; tracked stock_serials%ROWTYPE; target text; kind_key text; doc uuid;
    warranty uuid; warranty_serial text; original stock_movements%ROWTYPE; prev_transfer uuid;
BEGIN
    IF NOT EXISTS(SELECT 1 FROM stock_serial_products WHERE tenant_id=NEW.tenant_id AND product_id=NEW.product_id) THEN
        IF cardinality(NEW.serial_numbers)>0 THEN RAISE EXCEPTION USING ERRCODE='P4101',MESSAGE='Ative o controle de série do produto'; END IF;
        RETURN NULL;
    END IF;
    numbers:=NEW.serial_numbers;
    SELECT q.case_id,c.serial_number INTO warranty,warranty_serial FROM warranty_quarantines q
        JOIN warranty_cases c ON c.tenant_id=q.tenant_id AND c.id=q.case_id
        WHERE q.tenant_id=NEW.tenant_id AND (q.stock_movement_id=NEW.id OR q.release_movement_id=NEW.id);
    IF NEW.reverses_id IS NOT NULL THEN
        SELECT * INTO STRICT original FROM stock_movements WHERE tenant_id=NEW.tenant_id AND id=NEW.reverses_id;
        SELECT array_agg(serial ORDER BY serial) INTO numbers FROM stock_serial_events WHERE tenant_id=NEW.tenant_id AND movement_id=original.id;
    ELSIF NEW.transfer_id IS NOT NULL AND NEW.direction='receipt' THEN
        SELECT array_agg(e.serial ORDER BY e.serial) INTO numbers FROM stock_serial_events e JOIN stock_movements m
            ON m.id=e.movement_id AND m.tenant_id=e.tenant_id WHERE m.tenant_id=NEW.tenant_id AND m.transfer_id=NEW.transfer_id
            AND m.product_id=NEW.product_id AND m.direction='issue';
    ELSIF warranty IS NOT NULL THEN
        numbers:=ARRAY[warranty_serial];
    ELSIF NEW.source_order_id IS NOT NULL THEN kind_key:='sale'; doc:=NEW.source_order_id;
    ELSIF NEW.source_pos_sale_id IS NOT NULL THEN
        kind_key:='pos'; SELECT session_id INTO doc FROM pos_sales WHERE tenant_id=NEW.tenant_id AND id=NEW.source_pos_sale_id;
    ELSIF NEW.source_purchase_receipt_id IS NOT NULL THEN
        kind_key:='purchase'; SELECT order_id INTO doc FROM purchase_receipts WHERE tenant_id=NEW.tenant_id AND id=NEW.source_purchase_receipt_id;
    ELSIF NEW.production_order_id IS NOT NULL THEN kind_key:='production'; doc:=NEW.production_order_id;
    ELSIF NEW.inventory_count_id IS NOT NULL THEN kind_key:='count'; doc:=NEW.inventory_count_id;
    END IF;
    IF kind_key IS NOT NULL AND numbers IS NULL THEN
        SELECT a.serials INTO numbers FROM stock_serial_assignments a WHERE tenant_id=NEW.tenant_id AND product_id=NEW.product_id
            AND a.kind=kind_key AND document_id=doc AND direction=NEW.direction FOR UPDATE;
        UPDATE stock_serial_assignments SET serials='{}',revision=revision+1 WHERE tenant_id=NEW.tenant_id AND product_id=NEW.product_id
            AND kind=kind_key AND document_id=doc AND direction=NEW.direction;
    END IF;
    IF cardinality(coalesce(numbers,'{}'))::bigint*1000000<>NEW.quantity_micros OR EXISTS (
        SELECT 1 FROM unnest(numbers) n GROUP BY n HAVING n IS NULL OR length(btrim(n)) NOT BETWEEN 1 AND 120 OR btrim(n)<>n OR count(*)>1
    ) THEN RAISE EXCEPTION USING ERRCODE='P4101',MESSAGE='Informe uma série distinta para cada unidade movimentada'; END IF;
    FOREACH serial_no IN ARRAY numbers LOOP
        SELECT * INTO tracked FROM stock_serials WHERE tenant_id=NEW.tenant_id AND product_id=NEW.product_id AND serial=serial_no FOR UPDATE;
        target:=NULL;
        IF NEW.direction='issue' THEN
            IF tracked.warehouse_id=NEW.warehouse_id AND (tracked.status='available' OR
                    (tracked.status='reserved' AND tracked.reserved_order_id=NEW.source_order_id)) AND
                    (NEW.reverses_id IS NULL OR tracked.last_movement_id=NEW.reverses_id) THEN
                target:=CASE WHEN NEW.transfer_id IS NOT NULL THEN 'in_transit' WHEN warranty IS NOT NULL THEN 'service'
                    WHEN NEW.source_order_id IS NOT NULL OR NEW.source_pos_sale_id IS NOT NULL THEN 'sold' ELSE 'written_off' END;
            END IF;
        ELSIF NEW.transfer_id IS NOT NULL THEN
            SELECT transfer_id INTO prev_transfer FROM stock_movements WHERE tenant_id=NEW.tenant_id AND id=tracked.last_movement_id;
            IF tracked.status='in_transit' AND prev_transfer=NEW.transfer_id THEN target:='available'; END IF;
        ELSIF NEW.reverses_id IS NOT NULL THEN
            IF tracked.last_movement_id=NEW.reverses_id AND tracked.status IN ('sold','written_off','service') THEN target:='available'; END IF;
        ELSIF tracked.serial IS NULL THEN target:='available';
        END IF;
        IF target IS NULL THEN RAISE EXCEPTION USING ERRCODE='P4101',MESSAGE='Série já utilizada ou indisponível para este movimento: '||serial_no; END IF;
        INSERT INTO stock_serials(tenant_id,product_id,serial,warehouse_id,status,last_movement_id)
            VALUES(NEW.tenant_id,NEW.product_id,serial_no,NEW.warehouse_id,target,NEW.id)
            ON CONFLICT (tenant_id,product_id,serial) DO UPDATE SET warehouse_id=excluded.warehouse_id,status=excluded.status,
                reserved_order_id=NULL,last_movement_id=excluded.last_movement_id;
        INSERT INTO stock_serial_events(tenant_id,product_id,serial,warehouse_id,status,movement_id,order_id,pos_sale_id,warranty_id)
            VALUES(NEW.tenant_id,NEW.product_id,serial_no,NEW.warehouse_id,target,NEW.id,
                coalesce(NEW.source_order_id,original.source_order_id),coalesce(NEW.source_pos_sale_id,original.source_pos_sale_id),warranty);
    END LOOP;
    RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER track_serials AFTER INSERT ON stock_movements DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION track_stock_serial_movement();

CREATE FUNCTION dispose_quarantine_serial() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status='disposed' AND OLD.status='quarantined' THEN
        WITH disposed AS (UPDATE stock_serials SET status='written_off' WHERE tenant_id=NEW.tenant_id AND product_id=NEW.product_id
            AND last_movement_id=NEW.stock_movement_id AND status='service' RETURNING *)
            INSERT INTO stock_serial_events(tenant_id,product_id,serial,warehouse_id,status,warranty_id)
            SELECT tenant_id,product_id,serial,warehouse_id,status,NEW.case_id FROM disposed;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER dispose_quarantine_serial AFTER UPDATE OF status ON warranty_quarantines FOR EACH ROW EXECUTE FUNCTION dispose_quarantine_serial();

CREATE FUNCTION find_warranty_serial_sale() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sold record;
BEGIN
    IF NEW.product_id IS NOT NULL AND NEW.serial_number IS NOT NULL AND EXISTS (
        SELECT 1 FROM stock_serial_products WHERE tenant_id=NEW.tenant_id AND product_id=NEW.product_id
    ) THEN
        SELECT e.order_id,o.customer_id INTO sold FROM stock_serial_events e JOIN sales_orders o ON (o.tenant_id,o.id)=(e.tenant_id,e.order_id)
            WHERE e.tenant_id=NEW.tenant_id AND e.product_id=NEW.product_id AND e.serial=NEW.serial_number AND e.status='sold'
            ORDER BY e.id DESC LIMIT 1;
        IF FOUND THEN
            IF (NEW.order_id IS NOT NULL AND NEW.order_id<>sold.order_id) OR (NEW.customer_id IS NOT NULL AND NEW.customer_id<>sold.customer_id)
            THEN RAISE EXCEPTION USING ERRCODE='P4101',MESSAGE='O pedido ou cliente diverge da venda desta série'; END IF;
            NEW.order_id:=sold.order_id; NEW.customer_id:=sold.customer_id;
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER find_warranty_serial_sale BEFORE INSERT ON warranty_cases FOR EACH ROW EXECUTE FUNCTION find_warranty_serial_sale();
