import type { DatabasePool } from "../../platform/database.js"
import { projectedCosts,type CostContext } from "./valuation.js"

function chunks<T>(items:T[]) {
  const results:T[][]=[]
  for(let index=0;index<items.length;index+=500) results.push(items.slice(index,index+500))
  return results
}
export async function recalculateCosts(ctx:CostContext, retryFailed:boolean, limit=25) {
  const {client,tenantId}=ctx
  const selected=await client.query<{product_id:string}>(`SELECT product_id FROM stock_cost_jobs WHERE tenant_id=$1
    AND (status='pending' OR $2 AND status='failed') ORDER BY updated_at,product_id LIMIT $3 FOR UPDATE SKIP LOCKED`,[tenantId,retryFailed,limit])
  let completed=0
  for(const {product_id:id} of selected.rows) {
    await client.query("SAVEPOINT stock_cost_projection")
    try {
      const {movements,positions}=await projectedCosts(ctx,[id])
      const valued=[...movements.values()].map(m=>({id:m.id,amount:m.amount?.toString()??null,unit:m.unit?.toString()??null,
        value:m.valueAfter?.toString()??null,quantity:m.quantityAfter.toString()}))
      for(const rows of chunks(valued)) await client.query(`INSERT INTO stock_movement_values(tenant_id,movement_id,product_id,amount_micros,unit_micros,position_value_micros,position_quantity)
        SELECT $1,x.id,$2,x.amount,x.unit,x.value,x.quantity FROM jsonb_to_recordset($3::jsonb) AS x(id uuid,amount numeric,unit numeric,value numeric,quantity numeric)
        ON CONFLICT(tenant_id,movement_id) DO UPDATE SET amount_micros=excluded.amount_micros,unit_micros=excluded.unit_micros,
        position_value_micros=excluded.position_value_micros,position_quantity=excluded.position_quantity`,[tenantId,id,JSON.stringify(rows)])
      for(const p of positions.values()) await client.query(`INSERT INTO stock_valued_positions(tenant_id,product_id,warehouse_id,quantity_micros,value_micros)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,product_id,warehouse_id) DO UPDATE SET quantity_micros=excluded.quantity_micros,value_micros=excluded.value_micros`,
        [tenantId,p.productId,p.warehouseId,p.quantity,p.value])
      await client.query("UPDATE stock_cost_jobs SET status='done',updated_at=clock_timestamp(),error_text=NULL WHERE tenant_id=$1 AND product_id=$2",[tenantId,id])
      completed++
    } catch {
      await client.query("ROLLBACK TO SAVEPOINT stock_cost_projection")
      await client.query("UPDATE stock_cost_jobs SET status='failed',updated_at=clock_timestamp(),error_text='Falha no recálculo. A execução pode ser repetida.' WHERE tenant_id=$1 AND product_id=$2",[tenantId,id])
    }
    await client.query("RELEASE SAVEPOINT stock_cost_projection")
  }
  await client.query(`UPDATE stock_cost_dispatch SET requested_at=CASE WHEN EXISTS(SELECT 1 FROM stock_cost_jobs WHERE tenant_id=$1 AND status='pending')
    THEN clock_timestamp() ELSE NULL END WHERE tenant_id=$1`,[tenantId])
  return {tenantId,processed:completed,failed:selected.rows.length-completed}
}

export function startCostWorker(pool:DatabasePool) {
  let stopped=false, inFlight:Promise<void>|undefined
  async function run() {
    const client=await pool.connect()
    try {
      await client.query("BEGIN")
      await client.query("SELECT set_config('app.stock_cost_poll','1',true)")
      const job=await client.query<{tenant_id:string}>(`SELECT tenant_id FROM stock_cost_dispatch WHERE requested_at IS NOT NULL
        ORDER BY requested_at,tenant_id LIMIT 1`)
      if(job.rows[0]) {
        const tenantId=job.rows[0].tenant_id
        await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId])
        // Take the same tenant lock as API writers before product and dispatch locks.
        await client.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE",[tenantId])
        await recalculateCosts({client,tenantId},false,10)
      }
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {client.release()}
  }
  const timer=setInterval(()=>{
    if(!stopped && !inFlight) inFlight=run().catch(()=>{}).finally(()=>{inFlight=undefined})
  },3000)
  timer.unref()
  return async()=>{stopped=true;clearInterval(timer);await inFlight}
}
