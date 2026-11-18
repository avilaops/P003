ALTER TABLE system_config.report_definitions DROP CONSTRAINT report_definitions_dataset_check,
    ADD CHECK (dataset IN (
        'products','parties','sales_orders','stock_movements','audit_log',
        'stock_position','stock_kardex','stock_turnover','stock_idle','stock_divergences','stock_abc','stock_accuracy',
        'stock_movement_activity','stock_count_progress','stock_production_progress','stock_movement_ledger'
    ));
