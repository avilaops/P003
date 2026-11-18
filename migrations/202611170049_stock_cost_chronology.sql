ALTER TABLE stock_cost_inputs ADD COLUMN revision bigint NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION queue_stock_cost(company uuid, product uuid, effective date) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    WITH RECURSIVE affected(product_id) AS (
      SELECT product
      UNION
      SELECT receipt.product_id FROM affected a
        JOIN stock_movements issue ON issue.tenant_id=company AND issue.product_id=a.product_id
        JOIN production_posting_inputs i ON (i.tenant_id,i.movement_id)=(issue.tenant_id,issue.id)
        JOIN production_postings p ON (p.tenant_id,p.id)=(i.tenant_id,i.posting_id)
        JOIN stock_movements receipt ON (receipt.tenant_id,receipt.id)=(p.tenant_id,p.receipt_id)
    )
    INSERT INTO stock_cost_jobs(tenant_id,product_id,dirty_since,status)
        SELECT company,product_id,effective,'pending' FROM affected ORDER BY product_id
        ON CONFLICT(tenant_id,product_id) DO UPDATE SET dirty_since=CASE WHEN stock_cost_jobs.status='done' THEN excluded.dirty_since
        ELSE least(stock_cost_jobs.dirty_since,excluded.dirty_since) END,status='pending',updated_at=clock_timestamp(),error_text=NULL;
    INSERT INTO stock_cost_dispatch(tenant_id,requested_at) VALUES(company,clock_timestamp()) ON CONFLICT(tenant_id)
        DO UPDATE SET requested_at=excluded.requested_at;
END $$;

CREATE FUNCTION return_stock_movements(summary jsonb) RETURNS SETOF uuid LANGUAGE sql IMMUTABLE AS $$
    SELECT DISTINCT id::uuid FROM (
      SELECT jsonb_array_elements_text(summary->'stockMovementIds') id
      UNION ALL SELECT jsonb_array_elements_text(summary#>'{reconciliation,production,stockMovementIds}')
    ) ids
$$;
CREATE OR REPLACE FUNCTION date_stock_commercial_return() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE origin record;
BEGIN
    FOR origin IN SELECT i.movement_id,i.product_id,i.effective_on FROM return_stock_movements(NEW.summary) ids(id)
        JOIN stock_cost_inputs i ON i.tenant_id=NEW.tenant_id AND i.movement_id=ids.id LOOP
        PERFORM check_stock_open_period(NEW.tenant_id,NEW.occurred_on);
        UPDATE stock_cost_inputs SET effective_on=NEW.occurred_on WHERE tenant_id=NEW.tenant_id AND movement_id=origin.movement_id;
        PERFORM queue_stock_cost(NEW.tenant_id,origin.product_id,least(NEW.occurred_on,origin.effective_on));
    END LOOP;
    RETURN NEW;
END $$;
DO $migration$
DECLARE company uuid; count_rows bigint; prior text:=coalesce(current_setting('app.tenant_id',true),'');
BEGIN
    EXECUTE format('CREATE POLICY stock_cost_date_bootstrap ON tenants FOR SELECT TO %I USING (true)',current_user);
    FOR company IN SELECT id FROM tenants LOOP
        PERFORM set_config('app.tenant_id',company::text,true);
        WITH revised AS (
            SELECT c.occurred_on,movements.id FROM sales_order_cancellations c
            CROSS JOIN LATERAL return_stock_movements(c.summary) movements(id) WHERE c.tenant_id=company
        ), changes AS (
            UPDATE stock_cost_inputs i SET effective_on=r.occurred_on FROM revised r WHERE i.tenant_id=company AND i.movement_id=r.id
                AND i.effective_on<>r.occurred_on RETURNING i.product_id,i.effective_on
        )
        SELECT count(queue_stock_cost(company,product_id,effective_on)) FROM changes INTO count_rows;
    END LOOP;
    DROP POLICY stock_cost_date_bootstrap ON tenants;
    PERFORM set_config('app.tenant_id',prior,true);
END $migration$;

CREATE FUNCTION validate_stock_chronology() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry record; original date; current_quantity numeric; deficit boolean;
BEGIN
    SELECT i.effective_on,m.id,m.reverses_id,m.created_at,coalesce(m.warehouse_id,s.opening_id) warehouse_id
        INTO STRICT entry FROM stock_cost_inputs i JOIN stock_movements m ON (m.tenant_id,m.id)=(i.tenant_id,i.movement_id)
        JOIN stock_location_settings s ON s.tenant_id=i.tenant_id WHERE i.tenant_id=NEW.tenant_id AND i.movement_id=NEW.movement_id;
    IF entry.reverses_id IS NOT NULL THEN
        SELECT effective_on INTO original FROM stock_cost_inputs WHERE tenant_id=NEW.tenant_id AND movement_id=entry.reverses_id;
        IF entry.effective_on<original THEN RAISE EXCEPTION USING ERRCODE='P4101',MESSAGE='O estorno não pode anteceder o movimento original'; END IF;
    END IF;
    -- Only a backdated move or a later-dated existing entry can change an
    -- intermediate position; current-day postings already validate at write time.
    IF entry.effective_on>=(entry.created_at AT TIME ZONE 'America/Sao_Paulo')::date AND NOT EXISTS(
      SELECT 1 FROM stock_cost_inputs WHERE tenant_id=NEW.tenant_id AND product_id=NEW.product_id AND effective_on>entry.effective_on
    ) THEN RETURN NULL; END IF;
    SELECT coalesce(sum(quantity_micros),0) INTO current_quantity FROM stock_positions
        WHERE tenant_id=NEW.tenant_id AND product_id=NEW.product_id AND warehouse_id=entry.warehouse_id;
    WITH changes AS (
        SELECT i.effective_on,m.created_at,m.id,CASE m.direction WHEN 'receipt' THEN m.quantity_micros ELSE -m.quantity_micros END AS delta
        FROM stock_cost_inputs i JOIN stock_movements m ON (m.tenant_id,m.id)=(i.tenant_id,i.movement_id)
        JOIN stock_location_settings s ON s.tenant_id=m.tenant_id WHERE i.tenant_id=NEW.tenant_id AND i.product_id=NEW.product_id
        AND coalesce(m.warehouse_id,s.opening_id)=entry.warehouse_id AND i.effective_on>=entry.effective_on
    ), positions AS (
        SELECT current_quantity-coalesce(sum(delta) OVER(ORDER BY effective_on DESC,created_at DESC,id DESC ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) qty
        FROM changes
    ) SELECT EXISTS(SELECT 1 FROM positions WHERE qty<0) INTO deficit;
    IF deficit THEN RAISE EXCEPTION USING ERRCODE='P4101',MESSAGE='Saldo histórico insuficiente no depósito na data efetiva'; END IF;
    RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER validate_stock_chronology AFTER INSERT OR UPDATE OF effective_on ON stock_cost_inputs
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_stock_chronology();
