import { randomUUID } from "node:crypto"
import type { Revision } from "../../platform/revision.js"
import { accountBalance, accounts, bumpSession, ledgerEntry } from "./cash.js"
import { lockSession, reservedSql, saleDetail, sessionDetail, type Context } from "./read.js"
import { conflict, invalid, missing, minor, money, type Checkout } from "./schema.js"
import { priceFor } from "./pricing.js"

async function stockMovement(c:Context, sale:string, product:string, quantity:bigint, balance:bigint, reason:string, reverses:string|null=null) {
  const id=randomUUID()
  await c.client.query("UPDATE stock_balances SET quantity_micros=$3 WHERE tenant_id=$1 AND product_id=$2",[c.tenantId,product,balance])
  await c.client.query("INSERT INTO stock_movements(tenant_id,id,product_id,direction,quantity_micros,balance_after_micros,reason,source_pos_sale_id,reverses_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",[c.tenantId,id,product,reverses?"receipt":"issue",quantity,balance,Array.from(reason).slice(0,500).join(""),sale,reverses])
  return id
}
export async function checkout(c:Context,id:string,revision:Revision,input:Checkout) {
  const cash=await lockSession(c,id,revision)
  const customer=input.customerId ? (await c.client.query('SELECT id,legal_name AS name,tax_id AS "taxId" FROM parties WHERE tenant_id=$1 AND id=$2 AND is_customer AND status=\'active\'',[c.tenantId,input.customerId])).rows[0] ?? conflict("Cliente deve estar ativo nesta empresa") : null
  const ids=input.items.map(item=>item.productId)
  if (new Set(ids).size!==ids.length) invalid("Agrupe cada produto em um único item")
  const balances=await c.client.query("SELECT product_id,quantity_micros FROM stock_balances WHERE tenant_id=$1 AND product_id=ANY($2::uuid[]) ORDER BY product_id FOR UPDATE",[c.tenantId,ids])
  const balanceById=new Map(balances.rows.map(row=>[String(row.product_id),BigInt(String(row.quantity_micros))]))
  const items=[], stock=[]
  let total=0n
  for (const item of input.items) {
    const product=(await c.client.query(`SELECT sku,name,unit,price_cents,(${reservedSql}) AS reserved FROM products p WHERE p.tenant_id=$1 AND p.id=$2 AND p.status='active'`,[c.tenantId,item.productId])).rows[0] ?? conflict("Produto deve estar ativo nesta empresa")
    const quantity=minor(item.quantity)
    if (quantity===0n) invalid("Quantidade deve ser positiva")
    const quote=await priceFor(c,item.productId,BigInt(String(product.price_cents)),quantity,input.destination,input.taxpayer)
    if (quote.amount<=0n) invalid("Produto precisa ter valor comercial positivo")
    total+=quote.amount
    if (total>99999999999999n) invalid("Total fora do limite")
    const balance=balanceById.get(item.productId) ?? 0n
    if (balance-BigInt(String(product.reserved))<quantity) conflict("Estoque disponível insuficiente. As reservas comerciais estão preservadas")
    stock.push({product:item.productId,quantity,balance:balance-quantity})
    items.push({productId:item.productId,sku:product.sku,name:product.name,unit:product.unit,quantity:item.quantity,unitPrice:money(quote.unit),amount:money(quote.amount),total:money(quote.amount),pricing:quote.pricing})
  }
  if (minor(input.expectedTotal)!==total) conflict("O preço mudou. Atualize os itens e confirme o total novamente")
  const accountRows=await accounts(c,input.payments.map(p=>p.accountId))
  const payments=input.payments.map(p=>{
    const amount=minor(p.amount), tendered=minor(p.tendered ?? p.amount), account=accountRows.get(p.accountId)
    if (amount===0n || tendered<amount || p.method!=="cash" && tendered!==amount) invalid("Valor, dinheiro recebido ou troco inválido")
    if (p.method==="cash" && p.accountId!==cash) invalid("Dinheiro deve entrar na conta caixa da sessão")
    if (account?.status!=="active" || !(p.method==="cash"?account.account_type==="cash":["bank","internal"].includes(String(account.account_type)))) conflict("Conta de recebimento inativa ou incompatível com o meio de pagamento")
    return {method:p.method,accountId:p.accountId,amount:p.amount,tendered:money(tendered),change:money(tendered-amount)}
  })
  if (payments.reduce((sum,p)=>sum+minor(p.amount),0n)!==total) invalid("A soma dos pagamentos deve ser igual ao total da venda")
  const sale=randomUUID(), receipt={receiptType:"internal_non_fiscal",customer,destination:input.destination,taxpayer:input.taxpayer,items,payments}
  await c.client.query("INSERT INTO pos_sales(tenant_id,id,session_id,total_cents,receipt,created_by) VALUES($1,$2,$3,$4,$5,$6)",[c.tenantId,sale,id,total,receipt,c.authSubject])
  for (const row of stock) {
    const movement=await stockMovement(c,sale,row.product,row.quantity,row.balance,`Venda PDV ${sale}`)
    await c.client.query("INSERT INTO pos_sale_items(tenant_id,sale_id,product_id,quantity_micros,movement_id) VALUES($1,$2,$3,$4,$5)",[c.tenantId,sale,row.product,row.quantity,movement])
  }
  for (const p of payments) {
    const amount=minor(p.amount), entry=await ledgerEntry(c,p.accountId,amount,"credit",sale)
    await c.client.query("INSERT INTO pos_payments(tenant_id,id,sale_id,account_id,method,amount_cents,tendered_cents,entry_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[c.tenantId,randomUUID(),sale,p.accountId,p.method,amount,minor(p.tendered),entry])
  }
  await bumpSession(c,id)
  return saleDetail(c,sale)
}
export async function cancel(c:Context,id:string,revision:Revision,input:{reason:string}) {
  const ref=(await c.client.query("SELECT session_id FROM pos_sales WHERE tenant_id=$1 AND id=$2",[c.tenantId,id])).rows[0] ?? missing()
  const sessionId=String(ref.session_id)
  await lockSession(c,sessionId,revision)
  const sale=(await c.client.query("SELECT status FROM pos_sales WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[c.tenantId,id])).rows[0]!
  if (sale.status!=="completed") conflict("Esta venda já foi estornada")
  const items=(await c.client.query(`SELECT i.product_id,i.quantity_micros,i.movement_id,b.quantity_micros AS balance FROM pos_sale_items i JOIN stock_balances b ON b.tenant_id=i.tenant_id AND b.product_id=i.product_id WHERE i.tenant_id=$1 AND i.sale_id=$2 ORDER BY i.product_id FOR UPDATE OF b`,[c.tenantId,id])).rows
  const payments=(await c.client.query("SELECT account_id,method,amount_cents FROM pos_payments WHERE tenant_id=$1 AND sale_id=$2 ORDER BY account_id,id",[c.tenantId,id])).rows
  const amounts=new Map<string,bigint>()
  let cashRefund=0n
  for (const p of payments) {
    const amount=BigInt(String(p.amount_cents)),account=String(p.account_id)
    if (p.method==="cash") cashRefund+=amount
    amounts.set(account,(amounts.get(account)??0n)+amount)
  }
  if (minor((await sessionDetail(c,sessionId)).totals.expectedCash!)<cashRefund) conflict("Dinheiro disponível insuficiente para devolução")
  await accounts(c,[...amounts.keys()])
  for (const [account,amount] of amounts) {
    if (await accountBalance(c,account)<amount) conflict("Conta de recebimento sem saldo para estorno")
  }
  for (const row of items) {
    const quantity=BigInt(String(row.quantity_micros)), balance=BigInt(String(row.balance))+quantity
    if (balance>999999999999999999n) conflict("Estoque excede limite no estorno")
    await stockMovement(c,id,String(row.product_id),quantity,balance,`Estorno PDV ${id} • ${input.reason}`,String(row.movement_id))
  }
  for (const p of payments) await ledgerEntry(c,String(p.account_id),BigInt(String(p.amount_cents)),"debit",id)
  await c.client.query("UPDATE pos_sales SET status='cancelled',cancelled_at=clock_timestamp(),cancel_reason=$3,revision=revision+1 WHERE tenant_id=$1 AND id=$2",[c.tenantId,id,input.reason])
  await bumpSession(c,sessionId)
  return saleDetail(c,id)
}
