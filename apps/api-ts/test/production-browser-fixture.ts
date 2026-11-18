import {randomUUID} from "node:crypto"
import type {Pool} from "pg"

export async function prepareProductionBrowser(seed:Pool,tenant:string){
  const product=randomUUID(),part=randomUUID(),order=randomUUID()
  await seed.query("INSERT INTO role_permissions(role_id,permission_code) SELECT id,unnest(ARRAY['production.read','production.manage']) FROM roles WHERE code='editor' ON CONFLICT DO NOTHING")
  await seed.query(`INSERT INTO products(id,tenant_id,sku,name,unit,status,price_cents) VALUES
    ($1,$3,'BNC-OP','Banco para fábrica','UN','active',5000),($2,$3,'PRF-OP','Perfil de bancada','M','active',300)`,[product,part,tenant])
  await seed.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$2,'Academia • Fábrica','52998224725','2027-01-02',15000,'accepted')",[order,tenant])
  await seed.query("INSERT INTO sales_order_lines(tenant_id,order_id,line_number,product_id,sku,name,unit,quantity_micros,price_cents,amount_cents) VALUES($1,$2,1,$3,'BNC-OP','Banco para fábrica','UN',3000000,5000,15000)",[tenant,order,product])
  return {STOCK_TEST_FACTORY_PART:part,STOCK_TEST_FACTORY_ORDER:order}
}
