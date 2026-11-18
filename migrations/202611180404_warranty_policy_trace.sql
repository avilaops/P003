ALTER TABLE warranty_policies ADD COLUMN valid_from date, ADD COLUMN valid_until date,
 ADD CHECK(valid_until IS NULL OR valid_from IS NULL OR valid_until>=valid_from);

ALTER TABLE warranty_sold_equipment ALTER COLUMN serial_number DROP NOT NULL,
 ADD COLUMN lot text CHECK(length(trim(lot)) BETWEEN 1 AND 120),
 ADD COLUMN units integer NOT NULL DEFAULT 1 CHECK(units>0),
 ADD COLUMN policy_snapshot jsonb,
 ADD COLUMN trace_snapshot jsonb,
 ADD CHECK(serial_number IS NOT NULL OR lot IS NOT NULL),
 ADD CHECK(serial_number IS NULL OR units=1);

CREATE TRIGGER warranty_equipment_frozen BEFORE UPDATE OR DELETE ON warranty_sold_equipment
 FOR EACH ROW EXECUTE FUNCTION reject_audit_log_changes();

CREATE INDEX warranty_lot_identity ON warranty_sold_equipment(tenant_id,upper(trim(lot))) WHERE lot IS NOT NULL;
CREATE UNIQUE INDEX warranty_lot_invoice ON warranty_sold_equipment(tenant_id,document_id,line_number,upper(trim(lot))) WHERE serial_number IS NULL;

