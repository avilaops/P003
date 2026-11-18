import type {AuthorizedContext} from "../../platform/access.js"
import type {Origin} from "./policy.js"

export async function fiscalLots(c:AuthorizedContext,line:Origin) {
 return (await c.client.query<{lot:string;availableUnits:number}>(`
 WITH item AS (
  SELECT d.authorized_xml,CASE WHEN lot.id IS NULL THEN (SELECT count(*) FROM sales_order_lines l WHERE l.tenant_id=d.tenant_id AND l.order_id=$3 AND l.line_number<=$4)
    ELSE (SELECT count(*) FROM sales_invoice_lot_items i WHERE i.tenant_id=lot.tenant_id AND i.lot_id=lot.id AND i.line_number<=$4) END AS position
  FROM fiscal_nfe_documents d LEFT JOIN sales_invoice_lots lot ON (lot.tenant_id,lot.draft_id)=(d.tenant_id,d.id)
  WHERE d.tenant_id=$1 AND d.id=$2 AND d.environment='production' AND d.status='authorized'
 ), batches AS (
  SELECT trim(x.lot) AS lot,sum(CASE WHEN x.units ~ '^[0-9]{1,16}([.][0-9]{1,6})?$' THEN x.units::numeric ELSE 0 END) AS units
  FROM item CROSS JOIN LATERAL XMLTABLE(XMLNAMESPACES('http://www.portalfiscal.inf.br/nfe' AS n),
   '//n:infNFe/n:det/n:prod/n:rastro' PASSING CASE WHEN xml_is_well_formed_document(item.authorized_xml) THEN xmlparse(document item.authorized_xml) END
   COLUMNS lot text PATH 'n:nLote',units text PATH 'n:qLote',sku text PATH '../n:cProd',number integer PATH '../../@nItem') x
  WHERE x.sku=$5 AND x.number=item.position AND length(trim(x.lot))>0 GROUP BY trim(x.lot)
 )
 SELECT lot,greatest(0,least(2147483647,floor(units)-(SELECT coalesce(sum(e.units),0) FROM warranty_sold_equipment e
 WHERE e.tenant_id=$1 AND e.document_id=$2 AND e.line_number=$4 AND upper(trim(e.lot))=upper(batches.lot))))::int AS "availableUnits"
 FROM batches ORDER BY lot`,[c.tenantId,line.documentId,line.orderId,line.lineNumber,line.sku])).rows
}
