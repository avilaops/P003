ALTER TABLE warranty_service_order_parts ADD COLUMN stock_movement_id uuid;
ALTER TABLE warranty_service_order_parts ADD FOREIGN KEY (tenant_id,stock_movement_id) REFERENCES stock_movements(tenant_id,id);
CREATE UNIQUE INDEX warranty_part_movement_once ON warranty_service_order_parts(tenant_id,stock_movement_id) WHERE stock_movement_id IS NOT NULL;
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='erp_next_app') THEN
    GRANT SELECT,INSERT,UPDATE ON warranty_cases,warranty_service_orders,warranty_rmas,warranty_quarantines,stock_balances TO erp_next_app;
    GRANT SELECT,INSERT ON warranty_case_events,warranty_service_order_parts,warranty_approvals,warranty_policies,stock_movements TO erp_next_app;
  END IF;
END $$;
