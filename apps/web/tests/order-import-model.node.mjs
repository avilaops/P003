import assert from "node:assert/strict"
import { test } from "node:test"
import { parseOrderCsv, defaultMapping, mappedRows, exportText } from "../src/features/sales/imports/order-csv.ts"

test("CSV accepts BOM, quoted delimiters and newlines and retains physical source line numbers",()=>{
  const csv=parseOrderCsv('\uFEFFpedido_externo,documento_cliente,vencimento,sku,quantidade\r\n"a,b",0123,2027-01-31,"Produto ""A""\nLinha",1\r\n\r\nB,0123,2027-01-31,A,2')
  const rows=mappedRows(csv,defaultMapping(csv.headers))
  assert.equal(rows[0].line,2)
  assert.equal(rows[0].external,"a,b")
  assert.equal(rows[0].sku,'Produto "A"\nLinha')
  assert.equal(rows[1].line,5)
})
test("CSV rejects malformed input and duplicate column mappings, preserves formula text in exports",()=>{
  assert.throws(()=>parseOrderCsv('a;b\n1;"sem fechamento'),/Aspas abertas/)
  assert.throws(()=>parseOrderCsv('a;b\n1'),/linha 2/)
  const csv=parseOrderCsv("pedido_externo;documento_cliente;vencimento;sku;quantidade\n1;2;3;4;5")
  assert.throws(()=>mappedRows(csv,{...defaultMapping(csv.headers),quantity:3}),/coluna diferente/)
  assert.equal(exportText(" =1+1"),"' =1+1")
})
