-- Existing administrators can assign the new banking permissions through the normal role editor.
DO $migration$
DECLARE company uuid; previous_tenant text:=coalesce(current_setting('app.tenant_id',true),'');
BEGIN
    EXECUTE format('CREATE POLICY finance_permission_migration_scan ON tenants FOR SELECT TO %I USING(true)',current_user);
    FOR company IN SELECT id FROM tenants LOOP
        PERFORM set_config('app.tenant_id',company::text,true);
        WITH assigned AS (
            INSERT INTO role_permissions(role_id,permission_code)
            SELECT r.id,p.code FROM roles r CROSS JOIN permissions p
            WHERE r.tenant_id=company AND r.code IN ('admin','administrator')
              AND p.code IN ('finance.collections.read','finance.collections.manage','finance.reconciliation.close',
                             'finance.reconciliation.reopen','finance.discounts.approve','finance.settlements.approve','finance.charges.override')
            ON CONFLICT DO NOTHING RETURNING role_id
        )
        UPDATE roles SET revision=revision+1 WHERE tenant_id=company AND id IN (SELECT role_id FROM assigned);
    END LOOP;
    PERFORM set_config('app.tenant_id',previous_tenant,true);
    DROP POLICY finance_permission_migration_scan ON tenants;
END $migration$;
