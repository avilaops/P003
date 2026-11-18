DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='erp_next_app') THEN
    GRANT SELECT,INSERT,UPDATE ON commercial_settings,product_costs,fixed_expenses TO erp_next_app;
    GRANT SELECT,INSERT ON price_table_versions,price_table_items TO erp_next_app;
    GRANT SELECT ON financial_categories TO erp_next_app;
  END IF;
END $$;
