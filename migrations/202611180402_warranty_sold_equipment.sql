CREATE TABLE warranty_sold_equipment (
    tenant_id uuid NOT NULL, id uuid NOT NULL, serial_number text NOT NULL CHECK(length(trim(serial_number)) BETWEEN 1 AND 120),
    order_id uuid NOT NULL, line_number integer NOT NULL, document_id uuid NOT NULL, policy_id uuid NOT NULL,
    warranty_days integer NOT NULL CHECK(warranty_days BETWEEN 1 AND 3650), sold_on date NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,id),
    FOREIGN KEY(tenant_id,order_id,line_number) REFERENCES sales_order_lines(tenant_id,order_id,line_number),
    FOREIGN KEY(tenant_id,document_id) REFERENCES fiscal_nfe_documents(tenant_id,id),
    FOREIGN KEY(tenant_id,policy_id) REFERENCES warranty_policies(tenant_id,id)
);
CREATE UNIQUE INDEX warranty_serial_identity ON warranty_sold_equipment(tenant_id,upper(trim(serial_number)));
CREATE INDEX warranty_serial_invoice_line ON warranty_sold_equipment(tenant_id,document_id,line_number);
ALTER TABLE warranty_sold_equipment ENABLE ROW LEVEL SECURITY;
ALTER TABLE warranty_sold_equipment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON warranty_sold_equipment USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
    WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE warranty_cases ADD COLUMN equipment_id uuid;
ALTER TABLE warranty_cases ADD COLUMN document_id uuid, ADD COLUMN line_number integer;
ALTER TABLE warranty_cases ADD FOREIGN KEY(tenant_id,document_id) REFERENCES fiscal_nfe_documents(tenant_id,id);
ALTER TABLE warranty_cases ADD FOREIGN KEY(tenant_id,order_id,line_number) REFERENCES sales_order_lines(tenant_id,order_id,line_number);
ALTER TABLE warranty_cases ADD FOREIGN KEY(tenant_id,equipment_id) REFERENCES warranty_sold_equipment(tenant_id,id);
DO $$ BEGIN
    IF EXISTS(SELECT FROM pg_roles WHERE rolname='erp_next_app') THEN
        GRANT SELECT,INSERT ON warranty_sold_equipment TO erp_next_app;
    END IF;
END $$;
