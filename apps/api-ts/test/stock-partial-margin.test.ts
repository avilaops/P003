import assert from "node:assert/strict"
import {randomUUID} from "node:crypto"
import test from "node:test"
import {stockFixture} from "./stock-fixture.js"

test("margem física conserva o custo de cada lote após devoluções ao estoque e à assistência", {skip:!process.env.API_TS_TEST_ADMIN_URL}, async t=>{
  const {app,seed,tenant,close}=await stockFixture(process.env.API_TS_TEST_ADMIN_URL!)
  t.after(close)
  const product=randomUUID(),headers={authorization:"Bearer fixture-editor-token","x-tenant-id":tenant}
  await seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,'LOT-M','Peça','UN',3000,'active')",[product,tenant])
  await seed.query("INSERT INTO role_permissions SELECT id,unnest(ARRAY['sales.approvals.director','platform.company.manage']) FROM roles WHERE code='editor'")
  async function order(quantity:number) {
    const id=randomUUID()
    await seed.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$2,'Cliente','52998224725',CURRENT_DATE,$3,'completed')",[id,tenant,quantity*3000])
    await seed.query("INSERT INTO sales_order_lines(tenant_id,order_id,line_number,product_id,sku,name,unit,quantity_micros,price_cents,amount_cents) VALUES($1,$2,1,$3,'LOT-M','Peça','UN',$4,3000,$5)",[tenant,id,product,quantity*1000000,quantity*3000])
    return id
  }
  async function receipt(quantity:number,unitCost:number){
    const r=await app.inject({method:"POST",url:"/api/v1/stock/movements",headers:{...headers,"idempotency-key":randomUUID()},payload:{productId:product,direction:"receipt",quantity:quantity.toFixed(6),unitCost:unitCost.toFixed(6),reason:"Compra para venda"}})
    assert.equal(r.statusCode,201,r.body)
    return r.json().id as string
  }
  async function ship(orderId:string,quantity:number,origin:"lot"|"audit"|"full"){
    const lot=randomUUID(),movement=randomUUID()
    await seed.query("INSERT INTO sales_invoice_lots(tenant_id,id,order_id,environment,delivered_at,legacy_full) VALUES($1,$2,$3,'production',now(),$4)",[tenant,lot,orderId,origin==="full"])
    await seed.query("INSERT INTO sales_invoice_lot_items VALUES($1,$2,$3,1,$4)",[tenant,lot,orderId,quantity*1000000])
    const qty=quantity*1000000
    const balance=(await seed.query("UPDATE stock_balances SET quantity_micros=quantity_micros-$3 WHERE tenant_id=$1 AND product_id=$2 RETURNING quantity_micros",[tenant,product,qty])).rows[0].quantity_micros
    await seed.query("INSERT INTO stock_movements(id,tenant_id,product_id,direction,quantity_micros,balance_after_micros,reason,source_order_id,sales_invoice_lot_id) VALUES($1,$2,$3,'issue',$4,$5,'Entrega do pedido',$6,$7)",[movement,tenant,product,qty,balance,orderId,origin==="lot"?lot:null])
    if(origin==="audit")await seed.query("INSERT INTO audit_log(tenant_id,action,entity_type,entity_id,details) VALUES($1,'stock.moved','stock_movement',$2,$3)",[tenant,movement,{lotId:lot,orderId}])
    return lot
  }
  let documentNumber=0
  async function sendBack(orderId:string,lot:string,quantity:number,destination:"stock"|"service",historical=false){
    const n=++documentNumber, id=randomUUID(),qty=quantity*1000000,value=quantity*3000
    const document=(await seed.query(`INSERT INTO fiscal_received_nfes(tenant_id,access_key,issuer_document,issuer_name,recipient_document,number,series,issued_at,total_cents,item_count,environment,xml,xml_sha256,imported_by_identity_id)
      SELECT $1,$2,'04252011000110','Cliente','04252011000110',$3,1,now(),$4,1,1,'<xml/>',repeat('0',64),id FROM identities WHERE auth_subject='editor' RETURNING id`,[tenant,String(n).padStart(44,"0"),n,value])).rows[0].id
    await seed.query("INSERT INTO sales_partial_returns(tenant_id,id,lot_id,received_nfe_id,reason,destination,credited_cents,abated_cents) VALUES($1,$2,$3,$4,'Retorno de cliente',$5,$6,0)",[tenant,id,lot,document,destination,value])
    await seed.query("INSERT INTO sales_partial_return_items(tenant_id,return_id,lot_id,line_number,quantity_micros,value_cents) VALUES($1,$2,$3,1,$4,$5)",[tenant,id,lot,qty,value])
    if(destination==="service")return
    const balance=(await seed.query("UPDATE stock_balances SET quantity_micros=quantity_micros+$3 WHERE tenant_id=$1 AND product_id=$2 RETURNING quantity_micros",[tenant,product,qty])).rows[0].quantity_micros
    const movement=randomUUID()
    await seed.query("INSERT INTO stock_movements(id,tenant_id,product_id,direction,quantity_micros,balance_after_micros,reason,source_order_id,sales_invoice_lot_id,sales_partial_return_id) VALUES($1,$2,$3,'receipt',$4,$5,'Devolução parcial',$6,$7,$8)",[movement,tenant,product,qty,balance,orderId,historical?null:lot,historical?null:id])
    if(historical)await seed.query("INSERT INTO audit_log(tenant_id,action,entity_type,entity_id,details) VALUES($1,'stock.moved','stock_movement',$2,$3)",[tenant,movement,{returnId:id,orderId}])
    return movement
  }
  async function margin(orderId:string){
    const r=await app.inject({url:"/api/v1/orders/"+orderId,headers});assert.equal(r.statusCode,200,r.body)
    const m=r.json().realizedMargin
    return [m.revenue,m.cost,m.grossProfit]
  }
  async function onHand(){
    const r=await app.inject({url:"/api/v1/stock",headers});assert.equal(r.statusCode,200,r.body)
    return r.json().data.find((row:{productId:string})=>row.productId===product)?.stockValue
  }
  const sale=await order(5),firstPurchase=await receipt(2,10),first=await ship(sale,2,"audit")
  await receipt(3,20)
  const second=await ship(sale,3,"lot")
  assert.deepEqual(await margin(sale),["150.00","80.00","70.00"])
  const returned=await sendBack(sale,first,1,"stock",true)
  const basis=await app.inject({url:"/api/v1/stock/periods/basis?productId="+product+"&movementId="+returned,headers})
  assert.equal(basis.statusCode,200,basis.body)
  assert.deepEqual([basis.json().sourced,basis.json().amount],[true,"10.00"])
  const override=await app.inject({method:"POST",url:"/api/v1/stock/periods/basis",headers:{...headers,"idempotency-key":randomUUID()},payload:{kind:"receipt",productId:product,movementId:returned,amount:"99.00",freight:"0.00",recoverableTax:"0.00",reason:"Alteração manual",revision:1}})
  assert.equal(override.statusCode,422,override.body)
  assert.equal(await onHand(),"10.00")
  assert.deepEqual(await margin(sale),["120.00","70.00","50.00"])
  await sendBack(sale,second,1,"service")
  assert.deepEqual(await margin(sale),["90.00","70.00","20.00"])
  await sendBack(sale,first,1,"stock")
  assert.deepEqual(await margin(sale),["60.00","60.00","0.00"])
  const next=await order(2),full=await ship(next,2,"full")
  assert.deepEqual(await margin(next),["60.00","20.00","40.00"])
  await sendBack(next,full,1,"stock")
  assert.deepEqual(await margin(next),["30.00","10.00","20.00"])
  const revised=await app.inject({method:"POST",url:"/api/v1/stock/periods/basis",headers:{...headers,"idempotency-key":randomUUID()},payload:{kind:"receipt",productId:product,movementId:firstPurchase,freight:"4.00",recoverableTax:"0.00",reason:"Rateio de frete",revision:1}})
  assert.equal(revised.statusCode,200,revised.body)
  assert.deepEqual(await margin(sale),["60.00","60.00","0.00"])
  assert.deepEqual(await margin(next),["30.00","12.00","18.00"])
  assert.equal(await onHand(),"12.00")
})
