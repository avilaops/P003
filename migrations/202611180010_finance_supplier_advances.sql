ALTER TABLE finance_operations ADD COLUMN purchase_order_id uuid;
ALTER TABLE finance_operations ADD FOREIGN KEY (tenant_id,purchase_order_id) REFERENCES purchase_orders(tenant_id,id);
ALTER TABLE finance_operations ADD CHECK (purchase_order_id IS NULL OR (kind='advance' AND side='payable' AND order_id IS NULL));
CREATE INDEX finance_operations_purchase_advances ON finance_operations(tenant_id,purchase_order_id)
 WHERE purchase_order_id IS NOT NULL;
CREATE OR REPLACE VIEW finance_active_operations WITH (security_invoker=true) AS
 SELECT op.* FROM finance_operations op WHERE NOT EXISTS (
    SELECT FROM finance_operation_reversals rev
    WHERE (rev.tenant_id,rev.operation_id)=(op.tenant_id,op.id)
 );
