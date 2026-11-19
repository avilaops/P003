-- A runtime provisioned before the PDV migration needs its table privileges.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_next_app') THEN
    GRANT SELECT, INSERT, UPDATE ON pos_sessions, pos_sales TO erp_next_app;
    GRANT SELECT, INSERT ON pos_sale_items, pos_payments, pos_cash_movements TO erp_next_app;
  END IF;
END $$;
