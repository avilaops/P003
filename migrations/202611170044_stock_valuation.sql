-- Monetary values retain one millionth of a cent between ledger entries.
ALTER TABLE stock_movements ADD COLUMN effective_on date,
    ADD COLUMN input_value_micros numeric(40,0) CHECK (input_value_micros >= 0);
CREATE TABLE stock_cost_inputs (
    tenant_id uuid NOT NULL, movement_id uuid NOT NULL, product_id uuid NOT NULL, effective_on date NOT NULL,
    base_micros numeric(40,0) CHECK (base_micros>=0), freight_cents bigint NOT NULL DEFAULT 0 CHECK(freight_cents>=0),
    recoverable_cents bigint NOT NULL DEFAULT 0 CHECK(recoverable_cents>=0),
    PRIMARY KEY(tenant_id,movement_id), FOREIGN KEY(tenant_id,movement_id) REFERENCES stock_movements(tenant_id,id),
    FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id)
);
CREATE INDEX stock_cost_dates ON stock_cost_inputs(tenant_id,product_id,effective_on,movement_id);
CREATE TABLE stock_opening_costs (
    tenant_id uuid NOT NULL, product_id uuid NOT NULL, warehouse_id uuid NOT NULL, amount_micros numeric(40,0) NOT NULL CHECK(amount_micros>=0),
    PRIMARY KEY(tenant_id,product_id,warehouse_id), FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),
    FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id)
);
CREATE TABLE stock_cost_jobs (
    tenant_id uuid NOT NULL, product_id uuid NOT NULL, dirty_since date NOT NULL, status text NOT NULL CHECK(status IN ('pending','done','failed')),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), error_text text,
    PRIMARY KEY(tenant_id,product_id), FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id)
);
CREATE INDEX stock_cost_jobs_queue ON stock_cost_jobs(updated_at) WHERE status='pending';
CREATE TABLE stock_cost_dispatch (
    tenant_id uuid PRIMARY KEY REFERENCES tenants(id), requested_at timestamptz DEFAULT clock_timestamp()
);
CREATE TABLE stock_movement_values (
    tenant_id uuid NOT NULL, movement_id uuid NOT NULL, product_id uuid NOT NULL, amount_micros numeric(40,0), unit_micros numeric(40,0),
    position_value_micros numeric(40,0), position_quantity numeric(40,0) NOT NULL,
    PRIMARY KEY(tenant_id,movement_id), FOREIGN KEY(tenant_id,movement_id) REFERENCES stock_movements(tenant_id,id)
);
CREATE INDEX stock_movement_values_product ON stock_movement_values(tenant_id,product_id);
CREATE TABLE stock_valued_positions (
    tenant_id uuid NOT NULL, product_id uuid NOT NULL, warehouse_id uuid NOT NULL, quantity_micros numeric(40,0) NOT NULL,
    value_micros numeric(40,0), PRIMARY KEY(tenant_id,product_id,warehouse_id),
    FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id), FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id)
);
CREATE TABLE stock_periods (
    tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL, month date NOT NULL CHECK(EXTRACT(day FROM month)=1),
    closed_at timestamptz NOT NULL DEFAULT clock_timestamp(), closed_by text NOT NULL, reopened_at timestamptz, reopened_by text, reason text,
    PRIMARY KEY(tenant_id,id)
);
CREATE UNIQUE INDEX stock_period_active ON stock_periods(tenant_id,month) WHERE reopened_at IS NULL;
CREATE TABLE stock_period_positions (
    tenant_id uuid NOT NULL, period_id uuid NOT NULL, product_id uuid NOT NULL, warehouse_id uuid NOT NULL,
    quantity_micros numeric(40,0) NOT NULL, value_micros numeric(40,0),
    PRIMARY KEY(tenant_id,period_id,product_id,warehouse_id), FOREIGN KEY(tenant_id,period_id) REFERENCES stock_periods(tenant_id,id),
    FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id), FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id)
);
CREATE TRIGGER immutable_stock_period_snapshot BEFORE UPDATE OR DELETE ON stock_period_positions FOR EACH ROW EXECUTE FUNCTION reject_audit_log_changes();
INSERT INTO permissions(code,description) VALUES ('inventory.periods.close','Fechar e consultar competências do estoque'),
    ('inventory.periods.reopen','Reabrir competências fechadas do estoque') ON CONFLICT DO NOTHING;
DO $migration$
DECLARE tbl text;
BEGIN
    FOREACH tbl IN ARRAY ARRAY['stock_cost_inputs','stock_opening_costs','stock_cost_jobs','stock_cost_dispatch','stock_movement_values',
        'stock_valued_positions','stock_periods','stock_period_positions'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
        EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='erp_next_app') THEN
            EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO erp_next_app',tbl);
        END IF;
    END LOOP;
END $migration$;
-- The scheduler polls only tenant identifiers. Jobs, values and snapshots remain tenant scoped.
CREATE POLICY stock_cost_dispatch_poll ON stock_cost_dispatch FOR SELECT USING(current_setting('app.stock_cost_poll',true)='1');

CREATE FUNCTION check_stock_open_period(company uuid, effective date) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('stock-period:'||company::text,0));
    IF EXISTS(SELECT 1 FROM stock_periods WHERE tenant_id=company AND reopened_at IS NULL AND effective < month + interval '1 month') THEN
        RAISE EXCEPTION USING ERRCODE='P4101', MESSAGE='Movimentação recusada: competência de estoque fechada';
    END IF;
END $$;
CREATE FUNCTION queue_stock_cost(company uuid, product uuid, effective date) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO stock_cost_jobs(tenant_id,product_id,dirty_since,status) VALUES(company,product,effective,'pending')
    ON CONFLICT(tenant_id,product_id) DO UPDATE SET dirty_since=CASE WHEN stock_cost_jobs.status='done' THEN excluded.dirty_since
        ELSE least(stock_cost_jobs.dirty_since,excluded.dirty_since) END,status='pending',updated_at=clock_timestamp(),error_text=NULL;
    INSERT INTO stock_cost_dispatch(tenant_id,requested_at) VALUES(company,clock_timestamp()) ON CONFLICT(tenant_id)
        DO UPDATE SET requested_at=excluded.requested_at;
END $$;
CREATE FUNCTION prepare_stock_cost_movement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.effective_on:=coalesce(NEW.effective_on,nullif(current_setting('app.stock_effective_on',true),'')::date,
        (SELECT occurred_on FROM purchase_receipts WHERE tenant_id=NEW.tenant_id AND id=NEW.source_purchase_receipt_id),
        (NEW.created_at AT TIME ZONE 'America/Sao_Paulo')::date);
    NEW.input_value_micros:=coalesce(NEW.input_value_micros,nullif(current_setting('app.stock_input_value',true),'')::numeric);
    PERFORM check_stock_open_period(NEW.tenant_id,NEW.effective_on);
    RETURN NEW;
END $$;
CREATE TRIGGER prepare_stock_cost BEFORE INSERT ON stock_movements FOR EACH ROW EXECUTE FUNCTION prepare_stock_cost_movement();
CREATE FUNCTION initialize_stock_cost_movement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO stock_cost_inputs(tenant_id,movement_id,product_id,effective_on,base_micros)
        VALUES(NEW.tenant_id,NEW.id,NEW.product_id,NEW.effective_on,NEW.input_value_micros);
    PERFORM queue_stock_cost(NEW.tenant_id,NEW.product_id,NEW.effective_on);
    RETURN NEW;
END $$;
CREATE TRIGGER initialize_stock_cost AFTER INSERT ON stock_movements FOR EACH ROW EXECUTE FUNCTION initialize_stock_cost_movement();
CREATE FUNCTION date_stock_commercial_return() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE origin record;
BEGIN
    FOR origin IN SELECT i.movement_id,i.product_id,i.effective_on FROM jsonb_array_elements_text(NEW.summary->'stockMovementIds') ids(id)
        JOIN stock_cost_inputs i ON i.tenant_id=NEW.tenant_id AND i.movement_id=ids.id::uuid LOOP
        PERFORM check_stock_open_period(NEW.tenant_id,NEW.occurred_on);
        UPDATE stock_cost_inputs SET effective_on=NEW.occurred_on WHERE tenant_id=NEW.tenant_id AND movement_id=origin.movement_id;
        PERFORM queue_stock_cost(NEW.tenant_id,origin.product_id,least(NEW.occurred_on,origin.effective_on));
    END LOOP;
    RETURN NEW;
END $$;
CREATE TRIGGER stock_sale_return_date AFTER INSERT ON sales_order_cancellations FOR EACH ROW EXECUTE FUNCTION date_stock_commercial_return();
CREATE TRIGGER stock_purchase_return_date AFTER INSERT ON purchase_receipt_reversals FOR EACH ROW EXECUTE FUNCTION date_stock_commercial_return();

DO $migration$
DECLARE company uuid; prior text:=coalesce(current_setting('app.tenant_id',true),'');
BEGIN
    EXECUTE format('CREATE POLICY stock_cost_bootstrap ON tenants FOR SELECT TO %I USING (true)',current_user);
    FOR company IN SELECT id FROM tenants LOOP
        PERFORM set_config('app.tenant_id',company::text,true);
        INSERT INTO role_permissions(role_id,permission_code) SELECT r.id,p.code FROM roles r CROSS JOIN permissions p
            WHERE r.tenant_id=company AND r.code IN ('admin','administrator') AND p.code IN ('inventory.periods.close','inventory.periods.reopen')
            ON CONFLICT DO NOTHING;
        WITH returns AS (SELECT occurred_on,jsonb_array_elements_text(summary->'stockMovementIds')::uuid AS movement_id
                FROM sales_order_cancellations WHERE tenant_id=company
            UNION ALL SELECT occurred_on,jsonb_array_elements_text(summary->'stockMovementIds')::uuid FROM purchase_receipt_reversals WHERE tenant_id=company)
        INSERT INTO stock_cost_inputs(tenant_id,movement_id,product_id,effective_on)
            SELECT m.tenant_id,m.id,m.product_id,coalesce(ret.occurred_on,r.occurred_on,(m.created_at AT TIME ZONE 'America/Sao_Paulo')::date)
            FROM stock_movements m LEFT JOIN purchase_receipts r ON r.tenant_id=m.tenant_id AND r.id=m.source_purchase_receipt_id
            LEFT JOIN returns ret ON ret.movement_id=m.id WHERE m.tenant_id=company;
        INSERT INTO stock_cost_jobs(tenant_id,product_id,dirty_since,status)
            SELECT company,product_id,min(effective_on),'pending' FROM stock_cost_inputs WHERE tenant_id=company GROUP BY product_id;
        INSERT INTO stock_cost_dispatch(tenant_id) SELECT company WHERE EXISTS(SELECT 1 FROM stock_cost_jobs WHERE tenant_id=company);
    END LOOP;
    DROP POLICY stock_cost_bootstrap ON tenants;
    PERFORM set_config('app.tenant_id',prior,true);
END $migration$;
