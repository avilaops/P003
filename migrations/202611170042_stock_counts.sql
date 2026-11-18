ALTER TABLE inventory_counts
    ADD COLUMN warehouse_id uuid,
    ADD COLUMN category_id uuid,
    ADD COLUMN blind boolean NOT NULL DEFAULT false,
    ADD COLUMN lock_movements boolean NOT NULL DEFAULT false,
    ADD COLUMN recount_percent numeric(10,4) CHECK (recount_percent >= 0),
    ADD COLUMN cancelled_by text,
    ADD COLUMN cancel_reason text,
    ADD FOREIGN KEY (tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id),
    ADD FOREIGN KEY (tenant_id,category_id) REFERENCES product_categories(tenant_id,id);
ALTER TABLE inventory_count_lines
    ADD COLUMN counted_by text,
    ADD COLUMN recounted_by text,
    ADD COLUMN recounted_at timestamptz,
    ADD COLUMN stock_changed boolean NOT NULL DEFAULT false;
ALTER TABLE stock_movements ADD COLUMN inventory_count_id uuid,
    ADD FOREIGN KEY (tenant_id,inventory_count_id,product_id) REFERENCES inventory_count_lines(tenant_id,count_id,product_id);
CREATE UNIQUE INDEX stock_count_adjustment_per_product ON stock_movements(tenant_id,inventory_count_id,product_id)
    WHERE inventory_count_id IS NOT NULL;
CREATE INDEX inventory_open_scope ON inventory_counts(tenant_id,warehouse_id,id) WHERE status='open';

INSERT INTO permissions(code,description) VALUES ('inventory.counts.approve','Aprovar ajustes de inventários físicos de outro operador')
    ON CONFLICT DO NOTHING;
DO $migration$
DECLARE company uuid; prior text := coalesce(current_setting('app.tenant_id',true),'');
BEGIN
    EXECUTE format('CREATE POLICY count_scope_bootstrap ON tenants FOR SELECT TO %I USING (true)',current_user);
    FOR company IN SELECT id FROM tenants LOOP
        PERFORM set_config('app.tenant_id',company::text,true);
        WITH added AS (
            INSERT INTO role_permissions(role_id,permission_code)
            SELECT rp.role_id,'inventory.counts.approve' FROM role_permissions rp JOIN roles r ON r.id=rp.role_id
            WHERE r.tenant_id=company AND rp.permission_code='inventory.counts.manage'
            ON CONFLICT DO NOTHING RETURNING role_id
        ) UPDATE roles SET revision=revision+1 WHERE id IN (SELECT role_id FROM added);
        -- Preserve a legacy operator's identity when the old writer recorded a line audit.
        UPDATE inventory_count_lines l SET counted_by=(
            SELECT i.auth_subject FROM audit_log a JOIN identities i ON i.id=a.identity_id
            WHERE a.tenant_id=l.tenant_id AND a.entity_id=l.count_id::text AND a.action='inventory.count.line_counted'
                AND a.details->>'productId'=l.product_id::text ORDER BY a.occurred_at DESC,a.id DESC LIMIT 1
        ) FROM inventory_counts c
        WHERE (c.tenant_id,c.id)=(l.tenant_id,l.count_id) AND c.tenant_id=company AND c.status='open' AND l.counted_at IS NOT NULL;
        UPDATE inventory_count_lines l SET stock_changed=true FROM inventory_counts c
        WHERE (c.tenant_id,c.id)=(l.tenant_id,l.count_id) AND c.tenant_id=company AND c.status='open'
            AND EXISTS (SELECT 1 FROM stock_movements m WHERE (m.tenant_id,m.product_id)=(l.tenant_id,l.product_id)
                AND m.created_at>=c.created_at);
    END LOOP;
    PERFORM set_config('app.tenant_id',prior,true);
    DROP POLICY count_scope_bootstrap ON tenants;
END $migration$;

-- All movement writers append a row after changing the consolidated balance in the same transaction.
-- A scoped movement invalidates an unlocked count even if a later reversal restores the same quantity.
CREATE FUNCTION enforce_open_inventory_counts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.reverses_id IS NOT NULL AND EXISTS (SELECT 1 FROM stock_movements original
        WHERE original.tenant_id=NEW.tenant_id AND original.id=NEW.reverses_id AND original.inventory_count_id IS NOT NULL) THEN
        RAISE EXCEPTION USING ERRCODE='P4101',MESSAGE='Use uma nova conferência para corrigir um ajuste de inventário';
    END IF;
    IF NEW.inventory_count_id IS NOT NULL AND NEW.inventory_count_id::text IS DISTINCT FROM current_setting('app.inventory_count_id',true) THEN
        RAISE EXCEPTION USING ERRCODE='P4101',MESSAGE='Somente a aprovação do inventário pode lançar o ajuste';
    END IF;
    IF EXISTS (SELECT 1 FROM inventory_count_lines l JOIN inventory_counts c ON (c.tenant_id,c.id)=(l.tenant_id,l.count_id)
        WHERE l.tenant_id=NEW.tenant_id AND l.product_id=NEW.product_id AND c.status='open' AND c.lock_movements
            AND c.id IS DISTINCT FROM NEW.inventory_count_id AND (c.warehouse_id IS NULL OR c.warehouse_id=NEW.warehouse_id)) THEN
        RAISE EXCEPTION USING ERRCODE='P4101',MESSAGE='Produto bloqueado para conferência neste depósito';
    END IF;
    UPDATE inventory_count_lines l SET stock_changed=true FROM inventory_counts c
    WHERE (c.tenant_id,c.id)=(l.tenant_id,l.count_id) AND l.tenant_id=NEW.tenant_id AND l.product_id=NEW.product_id
        AND c.status='open' AND c.id IS DISTINCT FROM NEW.inventory_count_id AND NOT l.stock_changed
        AND (c.warehouse_id IS NULL OR c.warehouse_id=NEW.warehouse_id);
    RETURN NEW;
END $$;
CREATE TRIGGER check_open_inventory_counts AFTER INSERT ON stock_movements FOR EACH ROW EXECUTE FUNCTION enforce_open_inventory_counts();

-- The former writer recalculated its adjustment against current global stock. Prevent an obsolete
-- client from committing such adjustments when the physical count is approved independently.
CREATE FUNCTION verify_inventory_approval() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status='approved' AND OLD.status='open' AND NEW.id::text IS DISTINCT FROM current_setting('app.inventory_count_id',true) THEN
        RAISE EXCEPTION USING ERRCODE='P4101',MESSAGE='Conclua a aprovação na conferência de estoque';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER verify_inventory_approval BEFORE UPDATE OF status ON inventory_counts FOR EACH ROW EXECUTE FUNCTION verify_inventory_approval();
