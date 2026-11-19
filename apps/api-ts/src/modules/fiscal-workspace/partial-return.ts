import {lotSerials,type SerialSelection} from "./lot-serials.js"
import { randomUUID } from "node:crypto"
import { requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { record } from "../../platform/commands.js"
import { conflict } from "../orders/acceptance.js"
import type { CommandHeaders } from "../orders/receivables.js"
import { renderDanfe, sha256 } from "../nfe-email/danfe.js"

export type ReturnInput = {lotId:string; receivedId:string; reason:string; destination:"stock"|"service"|"discard";serials?:SerialSelection|undefined}
type Match = { line:number; product:string; quantity:string; value:string }

// Use the same private XML signature, protocol and schema verification as document downloads.
export async function verifyReturnDocument(c:AuthorizedContext, received:string, render:typeof renderDanfe) {
  requirePermission(c,"fiscal.received_nfe.manage")
  const row=(await c.client.query<{xml:string; key:string; issuer:string; digest:string}>(`SELECT xml,access_key AS key,
    issuer_document AS issuer,xml_sha256 AS digest FROM fiscal_received_nfes WHERE tenant_id=$1 AND id=$2 AND environment=1`,[c.tenantId,received])).rows[0]
  if (!row || sha256(row.xml)!==row.digest) conflict("Entrada fiscal de produção indisponível")
  await render({xml:row.xml,accessKey:row.key,issuerTaxId:row.issuer,environment:"production"})
  return row.digest
}

export async function matchItems(c:AuthorizedContext, order:string, input:ReturnInput, digest:string, own?:string) {
  const doc=(await c.client.query(`SELECT n.id FROM fiscal_received_nfes n JOIN tenants t ON t.id=n.tenant_id
    JOIN sales_orders o ON o.tenant_id=n.tenant_id AND o.id=$2 JOIN sales_invoice_lots l ON l.tenant_id=o.tenant_id AND l.order_id=o.id AND l.id=$3
    JOIN fiscal_nfe_documents d ON d.tenant_id=l.tenant_id AND d.id=l.draft_id
    CROSS JOIN LATERAL XMLTABLE(XMLNAMESPACES('http://www.portalfiscal.inf.br/nfe' AS n),'/n:nfeProc/n:NFe/n:infNFe/n:ide'
      PASSING xmlparse(document n.xml) COLUMNS purpose text PATH 'n:finNFe', model text PATH 'n:mod', direction text PATH 'n:tpNF') f
    WHERE n.tenant_id=$1 AND n.id=$4 AND n.xml_sha256=$5 AND n.environment=1
      AND ((n.own_return_document_id IS NULL AND $6::uuid IS NULL AND n.recipient_document=t.tax_id AND n.issuer_document=o.customer_tax_id AND f.direction='1')
        OR (n.own_return_document_id=$6 AND n.issuer_document=t.tax_id AND n.recipient_document=o.customer_tax_id AND f.direction='0'
          AND EXISTS(SELECT FROM sales_self_return_plans p JOIN fiscal_nfe_documents rd ON rd.tenant_id=p.tenant_id AND rd.id=p.id
            WHERE p.tenant_id=n.tenant_id AND p.id=$6 AND p.lot_id=l.id AND p.status='ready' AND rd.status='authorized' AND rd.authorized_xml=n.xml)))
      AND d.environment='production' AND d.status='authorized' AND l.delivered_at IS NOT NULL AND (xpath('string(/n:nfeProc/n:NFe/n:infNFe/n:dest/n:CNPJ | /n:nfeProc/n:NFe/n:infNFe/n:dest/n:CPF)',xmlparse(document n.xml),ARRAY[ARRAY['n','http://www.portalfiscal.inf.br/nfe']]))[1]::text=n.recipient_document AND f.model='55' AND f.purpose='4'
      AND d.access_key=(SELECT CASE WHEN count(*)=1 THEN min(k) END FROM XMLTABLE(XMLNAMESPACES('http://www.portalfiscal.inf.br/nfe' AS n),
        '/n:nfeProc/n:NFe/n:infNFe/n:ide/n:NFref' PASSING xmlparse(document n.xml) COLUMNS k text PATH 'n:refNFe') refs)
      AND NOT EXISTS(SELECT FROM sales_partial_returns r WHERE r.tenant_id=n.tenant_id AND r.received_nfe_id=n.id)
      AND NOT EXISTS(SELECT FROM fiscal_received_purchase_links p WHERE p.tenant_id=n.tenant_id AND p.received_nfe_id=n.id)`,[c.tenantId,order,input.lotId,input.receivedId,digest,own??null])).rows[0]
  if (!doc) conflict("Confira a chave de referência, emitente, destinatário e o vínculo da NF-e de devolução")
  const rows=await c.client.query<Match>(`
    WITH received AS (
      SELECT sku,unit,price,sum(qty*1000000) AS qty FROM fiscal_received_nfes n CROSS JOIN LATERAL
        XMLTABLE(XMLNAMESPACES('http://www.portalfiscal.inf.br/nfe' AS n),'/n:nfeProc/n:NFe/n:infNFe/n:det/n:prod' PASSING xmlparse(document n.xml)
        COLUMNS sku text PATH 'n:cProd',unit text PATH 'n:uCom',qty numeric PATH 'n:qCom',price numeric PATH 'n:vUnCom') b
        WHERE n.tenant_id=$1 AND n.id=$2 GROUP BY sku,unit,price
    ), matching AS (
      SELECT s.line_number AS line,s.product_id AS product,i.quantity_micros AS delivered,s.price_cents AS price,n.qty,s.amount_cents AS commercial_total,
        order_line_delivered(s.tenant_id,s.order_id,s.line_number) AS physically_delivered,
        (settled.exchanged+pending.quantity) AS exchanged,(settled.refunded+pending.amount) AS refunded,returned.all_quantity,returned.all_value,
        coalesce((SELECT sum(r.quantity_micros) FROM sales_partial_return_items r WHERE r.tenant_id=i.tenant_id AND r.lot_id=i.lot_id AND r.line_number=i.line_number),0) AS previous
      FROM received n LEFT JOIN sales_order_lines s ON s.tenant_id=$1 AND s.order_id=$3 AND s.sku=n.sku AND s.unit=n.unit AND order_line_fiscal_price(s)=n.price*100
      LEFT JOIN sales_invoice_lot_items i ON i.tenant_id=s.tenant_id AND i.order_id=s.order_id AND i.line_number=s.line_number AND i.lot_id=$4
      CROSS JOIN LATERAL sales_pending_return_balance(s.tenant_id,s.order_id,s.line_number,$5) pending
      LEFT JOIN LATERAL (SELECT coalesce(sum(w.quantity_micros) FILTER(WHERE kind='exchange'),0) AS exchanged,
        coalesce(sum(w.amount_cents) FILTER(WHERE kind IN('credit','refund')),0) AS refunded FROM warranty_settlements w
        WHERE w.tenant_id=s.tenant_id AND w.order_id=s.order_id AND w.line_number=s.line_number) settled ON true
      LEFT JOIN LATERAL (SELECT coalesce(sum(r.quantity_micros),0) AS all_quantity,coalesce(sum(r.value_cents),0) AS all_value
        FROM sales_partial_return_items r JOIN sales_invoice_lots l ON l.tenant_id=r.tenant_id AND l.id=r.lot_id
        WHERE r.tenant_id=s.tenant_id AND l.order_id=s.order_id AND r.line_number=s.line_number AND l.environment='production') returned ON true
    ), priced AS (
      SELECT matching.*,round((previous+qty)*price/1000000)-round(previous*price/1000000) AS value FROM matching
    )
    SELECT line,product,CASE WHEN qty>0 AND qty=trunc(qty) AND previous+qty<=delivered AND all_quantity+qty+exchanged<=physically_delivered
        AND all_value+value+refunded<=commercial_total THEN qty::bigint::text END AS quantity,value::bigint::text AS value FROM priced ORDER BY line`,[c.tenantId,input.receivedId,order,input.lotId,own??null])
  if (!rows.rows.length || rows.rows.some(item=>!item.line || !item.quantity)) conflict("Os itens, preços, unidades ou quantidades da entrada divergem do saldo entregue após devoluções e garantias")
  return rows.rows
}

async function reverseCommission(c:AuthorizedContext, order:string, reimbursed:bigint, reason:string) {
  // Commission accrues on receipts. Only amounts converted to credit against money already received affect that ledger.
  if (!reimbursed) return 0n
  const account=(await c.client.query(`SELECT t.seller_staff_id,t.seller_name,t.payment_day,t.commission_rate,t.ipi_rate,
      coalesce((SELECT sum(amount_cents) FROM commission_entries e WHERE e.tenant_id=t.tenant_id AND e.order_id=t.order_id AND e.kind IN('receipt','reversal')),0) AS earned,
      coalesce((SELECT sum(r.commission_reversed_cents) FROM sales_partial_returns r JOIN sales_invoice_lots l ON l.tenant_id=r.tenant_id AND l.id=r.lot_id WHERE l.tenant_id=t.tenant_id AND l.order_id=t.order_id),0) AS reversed,
      coalesce((SELECT sum(r.credited_cents) FROM sales_partial_returns r JOIN sales_invoice_lots l ON l.tenant_id=r.tenant_id AND l.id=r.lot_id WHERE l.tenant_id=t.tenant_id AND l.order_id=t.order_id),0) AS credits
    FROM order_commission_terms t WHERE t.tenant_id=$1 AND t.order_id=$2`,[c.tenantId,order])).rows[0]
  if (!account) return 0n
  const n=(v:unknown)=>BigInt(String(v))
  const rounded=(v:bigint,d:bigint)=>(v+d/2n)/d
  const total=rounded(rounded((n(account.credits)+reimbursed)*1000000n,1000000n+n(account.ipi_rate))*n(account.commission_rate),1000000n)
  const amount=(total<n(account.earned)?total:n(account.earned))-n(account.reversed)
  if (amount<=0n) return 0n
  requirePermission(c,"finance.commissions.manage")
  await c.client.query(`INSERT INTO commission_entries(id,tenant_id,seller_staff_id,seller_name,order_id,kind,competence,payment_due,base_cents,payment_day,amount_cents,reason)
    SELECT $1,$2,$3,$4,$5,'adjustment',first_day,(first_day+interval '1 month')::date+$6::int-1,0,$6,-$7::bigint,$8
    FROM (SELECT date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')::date AS first_day) dates`,
    [randomUUID(),c.tenantId,account.seller_staff_id,account.seller_name,order,account.payment_day,amount,reason])
  await c.client.query("UPDATE commission_accounts SET revision=revision+1 WHERE tenant_id=$1 AND seller_staff_id=$2",[c.tenantId,account.seller_staff_id])
  return amount
}

export async function applyPartialReturn(c:AuthorizedContext, headers:CommandHeaders, order:string, input:ReturnInput, items:Match[]) {
  const serials=await lotSerials(c,order,input.lotId,"return",items,input.serials)
  const total=items.reduce((sum,item)=>sum+BigInt(item.value),0n)
  const bills=await c.client.query(`SELECT r.id,r.amount_cents,r.status,p.paid,p.last_receipt FROM receivables r LEFT JOIN LATERAL (
      SELECT coalesce(sum(CASE kind WHEN 'receipt' THEN amount_cents ELSE -amount_cents END),0) AS paid,
        (array_agg(id ORDER BY created_at DESC,id) FILTER(WHERE kind='receipt' AND NOT EXISTS(SELECT FROM receivable_payments x WHERE x.tenant_id=p.tenant_id AND x.reverses_id=p.id)))[1] AS last_receipt
        FROM receivable_payments p WHERE p.tenant_id=r.tenant_id AND p.receivable_id=r.id) p ON true
    WHERE r.tenant_id=$1 AND r.order_id=$2 ORDER BY r.due_date,r.id FOR UPDATE OF r`,[c.tenantId,order])
  if (!bills.rows.length) conflict("Gere o título do pedido antes de conciliar a devolução")
  let remaining=total
  const allocations:{id:string;amount:bigint}[]=[]
  for (const bill of bills.rows) {
    if (!remaining || bill.status!=="open") continue
    const face=BigInt(String(bill.amount_cents)),paid=BigInt(String(bill.paid)),open=face-paid
    const applied=remaining<open ? remaining : open
    if (applied<=0n) continue
    const next=face-applied
    const status=next===0n ? "cancelled" : next===paid ? "paid" : "open"
    await c.client.query("UPDATE receivables SET amount_cents=$3,status=$4,payment_id=$5,revision=revision+1 WHERE tenant_id=$1 AND id=$2",[c.tenantId,bill.id,next || face,status,status==="paid"?bill.last_receipt:null])
    allocations.push({id:String(bill.id),amount:applied})
    remaining-=applied
  }
  const commission=await reverseCommission(c,order,remaining,input.reason)
  const id=randomUUID()
  await c.client.query(`INSERT INTO sales_partial_returns(tenant_id,id,lot_id,received_nfe_id,reason,destination,credited_cents,abated_cents,commission_reversed_cents)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[c.tenantId,id,input.lotId,input.receivedId,input.reason,input.destination,remaining,total-remaining,commission])
  for (const abate of allocations) {
    await c.client.query("INSERT INTO sales_return_abatements VALUES($1,$2,$3,$4)",[c.tenantId,id,abate.id,abate.amount])
    await record(c,headers,"receivable",abate.id,"receivable.abated",{orderId:order,returnId:id,amountCents:abate.amount.toString()})
  }
  for (const item of items) {
    await c.client.query("INSERT INTO sales_partial_return_items(tenant_id,return_id,lot_id,line_number,quantity_micros,value_cents,serial_numbers) VALUES($1,$2,$3,$4,$5,$6,$7)",[c.tenantId,id,input.lotId,item.line,item.quantity,item.value,serials.get(item.line)??null])
    if (input.destination!=="stock") continue
    const balance=(await c.client.query("UPDATE stock_balances SET quantity_micros=quantity_micros+$3 WHERE tenant_id=$1 AND product_id=$2 RETURNING quantity_micros",[c.tenantId,item.product,item.quantity])).rows[0]
    if (!balance) conflict("Saldo de estoque não encontrado para a linha devolvida")
    const movement=randomUUID()
    await c.client.query("INSERT INTO stock_movements(id,tenant_id,product_id,direction,quantity_micros,balance_after_micros,reason,source_order_id,sales_invoice_lot_id,sales_partial_return_id,serial_numbers) VALUES($1,$2,$3,'receipt',$4,$5,$6,$7,$8,$9,$10)",[movement,c.tenantId,item.product,item.quantity,balance.quantity_micros,input.reason,order,input.lotId,id,serials.get(item.line)??null])
    await record(c,headers,"stock_movement",movement,"stock.moved",{orderId:order,returnId:id,productId:item.product,quantityMicros:item.quantity,direction:"receipt"})
  }
  return id
}
