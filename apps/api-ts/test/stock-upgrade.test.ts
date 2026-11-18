import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { Pool } from "pg"
import { runMigrations } from "../src/platform/migrations.js"

const adminUrl = process.env.API_TS_TEST_ADMIN_URL
test("upgrade preserves imported balances, prior confirmed reservations and the append-only ledger", {skip:!adminUrl}, async () => {
  const original = fileURLToPath(new URL("../../../migrations",import.meta.url))
  const baseline = await mkdtemp(join(tmpdir(),"erp-stock-baseline-"))
  const name = "stock_upgrade_"+randomUUID().replaceAll("-","")
  const admin = new Pool({connectionString:adminUrl}), url=new URL(adminUrl!)
  url.pathname="/"+name
  const db=new Pool({connectionString:url.href})
  try {
    await admin.query("CREATE DATABASE "+name)
    for(const file of await readdir(original)) {
      if(file.endsWith(".sql") && file.split("_")[0]! < "202611170040") await copyFile(join(original,file),join(baseline,file))
    }
    await runMigrations(db,{directory:baseline})
    const tenant=randomUUID(), product=randomUUID(), originalMovement=randomUUID(), order=randomUUID(), archived=randomUUID()
    await db.query("INSERT INTO tenants(id,legal_name,tax_id) VALUES($1,'Empresa migrada','04252011000110')",[tenant])
    await db.query("INSERT INTO warehouses(id,tenant_id,code,name,status,revision) VALUES($1,$2,'PRINCIPAL','Depósito encerrado','archived',1)",[archived,tenant])
    await db.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,'LEG','Importado','UN',100,'active')",[product,tenant])
    await db.query("INSERT INTO stock_balances(tenant_id,product_id,quantity_micros) VALUES($1,$2,10000000)",[tenant,product])
    await db.query("INSERT INTO stock_movements(id,tenant_id,product_id,direction,quantity_micros,balance_after_micros,reason) VALUES($1,$2,$3,'receipt',2000000,10000000,'Complemento da abertura importada')",[originalMovement,tenant,product])
    await db.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$1,'fisica','Cliente','52998224725',true,false,'active')",[tenant])
    await db.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$2,'Cliente','52998224725','2027-01-02',300,'confirmed')",[order,tenant])
    await db.query("INSERT INTO sales_order_lines(tenant_id,order_id,line_number,product_id,sku,name,unit,quantity_micros,price_cents,amount_cents) VALUES($1,$2,1,$3,'LEG','Importado','UN',3000000,100,300)",[tenant,order,product])
    await runMigrations(db,{directory:original})
    assert.deepEqual((await runMigrations(db,{directory:original})).applied,[])
    const {rows:[settings]}=await db.query("SELECT opening_id,enabled FROM stock_location_settings WHERE tenant_id=$1",[tenant])
    assert.notEqual(settings.opening_id,archived)
    assert.equal(settings.enabled,false)
    assert.equal((await db.query("SELECT status FROM warehouses WHERE id=$1",[archived])).rows[0].status,"archived")
    assert.equal((await db.query("SELECT warehouse_id FROM stock_movements WHERE id=$1",[originalMovement])).rows[0].warehouse_id,null)
    assert.deepEqual((await db.query("SELECT warehouse_id,quantity_micros FROM stock_location_reservations WHERE tenant_id=$1",[tenant])).rows,
      [{warehouse_id:settings.opening_id,quantity_micros:"3000000"}])
    // Replay the old writer's INSERT with the pre-upgrade column set after activation.
    await db.query("UPDATE stock_balances SET quantity_micros=9000000 WHERE tenant_id=$1 AND product_id=$2",[tenant,product])
    await db.query("INSERT INTO stock_movements(id,tenant_id,product_id,direction,quantity_micros,balance_after_micros,reason) VALUES($1,$2,$3,'issue',1000000,9000000,'Consumo registrado após atualização')",[randomUUID(),tenant,product])
    assert.deepEqual((await db.query("SELECT warehouse_id,quantity_micros FROM stock_positions WHERE tenant_id=$1",[tenant])).rows,
      [{warehouse_id:settings.opening_id,quantity_micros:"9000000"}])
  } finally {
    await db.end()
    try {await admin.query("DROP DATABASE IF EXISTS "+name)} finally {await admin.end();await rm(baseline,{recursive:true,force:true})}
  }
})
