-- CA4: dados comerciais do cliente — vendedor responsável (carteira) e região junto ao crédito, condição e lista já existentes.
ALTER TABLE sales_customer_policies
 ADD COLUMN seller_staff_id uuid,
 ADD COLUMN region text CHECK (region IS NULL OR length(btrim(region)) BETWEEN 1 AND 80),
 ADD FOREIGN KEY (tenant_id,seller_staff_id) REFERENCES staff(tenant_id,id);
