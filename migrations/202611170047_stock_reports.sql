ALTER TABLE system_config.report_definitions DROP CONSTRAINT report_definitions_dataset_check,
  ADD CHECK (dataset IN ('products','parties','sales_orders','stock_movements','audit_log','stock_position','stock_kardex',
    'stock_turnover','stock_idle','stock_divergences','stock_abc','stock_accuracy'));

ALTER POLICY report_reader_authorization ON system_config.report_definitions USING (
  system_config.has_permission('system.reports.read')
  AND system_config.has_permission(CASE dataset WHEN 'products' THEN 'catalog.products.read' WHEN 'parties' THEN 'catalog.parties.read'
    WHEN 'sales_orders' THEN 'sales.orders.read' WHEN 'audit_log' THEN 'platform.audit.read' ELSE 'inventory.stock.read' END)
  AND (dataset NOT IN ('stock_divergences','stock_accuracy') OR system_config.has_permission('inventory.counts.read'))
  AND (visibility='tenant' OR EXISTS (SELECT 1 FROM public.identities i WHERE i.id=owner_identity_id
    AND i.auth_subject=nullif(current_setting('app.auth_subject',true),'')))
);

