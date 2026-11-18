-- Record the authorized command before asking the private engine to sign and transmit.
ALTER TABLE fiscal_monitor_manifestations ALTER COLUMN signed_xml DROP NOT NULL;
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='erp_next_app') THEN
   GRANT SELECT,INSERT ON fiscal_received_nfes,fiscal_distribution_documents,fiscal_monitor_documents,fiscal_received_purchase_links,fiscal_received_item_costs TO erp_next_app;
   GRANT SELECT,INSERT,UPDATE ON fiscal_distribution_cursors,fiscal_distribution_runs,fiscal_recipient_manifestations,fiscal_monitor_state,fiscal_monitor_runs,fiscal_monitor_manifestations,purchase_orders,purchase_order_lines TO erp_next_app;
   GRANT SELECT ON purchase_settings,company_profiles TO erp_next_app;
   GRANT SELECT,INSERT ON purchase_receipts,purchase_receipt_lines,payables,stock_movements TO erp_next_app;
   GRANT SELECT,INSERT,UPDATE ON stock_balances TO erp_next_app;
   GRANT USAGE,SELECT ON SEQUENCE fiscal_received_nfes_id_seq,fiscal_monitor_documents_id_seq TO erp_next_app;
 END IF;
END $$;
