import type { AuthorizedContext } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { orderSummary } from "../sales/shared.js"
import { loadCheckout } from "./checkout.js"

export const summary = "SELECT id,number::text AS number,customer_id,customer_name,customer_tax_id,due_date::text AS due_date,(amount_cents::numeric/100)::numeric(16,2)::text AS amount,status,revision,to_json(updated_at)#>>'{}' AS updated_at,(EXISTS(SELECT 1 FROM order_pricing_snapshots s WHERE s.tenant_id=sales_orders.tenant_id AND s.order_id=sales_orders.id) OR EXISTS(SELECT 1 FROM commercial_order_quotes q WHERE q.tenant_id=sales_orders.tenant_id AND q.order_id=sales_orders.id)) AS pricing_origin FROM sales_orders"

export async function loadOrder(context: AuthorizedContext, id: string) {
  const row = await context.client.query(`${summary} WHERE tenant_id=$1 AND id=$2`, [context.tenantId, id])
  if (!row.rows[0]) throw new Problem(404, "not_found", "Pedido não encontrado")
  const data = orderSummary(row.rows[0])
  const lines = await context.client.query("SELECT product_id,sku,name,unit,price_origin,(quantity_micros::numeric/1000000)::numeric(19,6)::text AS quantity,(price_cents::numeric/100)::numeric(16,2)::text AS unit_price,(amount_cents::numeric/100)::numeric(16,2)::text AS amount,structure_color,swing_arm_color,plate_holder_color,plate_holder_type,upholstery_color,CASE WHEN technical_snapshot IS NULL THEN (SELECT c.weight FROM product_catalog_profiles c WHERE c.tenant_id=sales_order_lines.tenant_id AND c.product_id=sales_order_lines.product_id) ELSE technical_snapshot->>'weight' END AS equipment_weight FROM sales_order_lines WHERE tenant_id=$1 AND order_id=$2 ORDER BY line_number", [context.tenantId, id])
  const items = lines.rows.map(item => ({
    ...(item.price_origin ? {priceOrigin:item.price_origin}:{}), productId: item.product_id, sku: item.sku, name: item.name, unit: item.unit, quantity: item.quantity, unitPrice: item.unit_price, amount: item.amount, equipmentWeight: item.equipment_weight,
    ...(item.structure_color == null ? {} : { structureColor: item.structure_color }),
    ...(item.swing_arm_color == null ? {} : { swingArmColor: item.swing_arm_color }),
    ...(item.plate_holder_color == null ? {} : { plateHolderColor: item.plate_holder_color }),
    ...(item.plate_holder_type == null ? {} : { plateHolderType: item.plate_holder_type }),
    ...(item.upholstery_color == null ? {} : { upholsteryColor: item.upholstery_color }),
  }))
  const checkout = await loadCheckout(context, id)
  const agreement = (await context.client.query("SELECT jsonb_build_object('proposalId',p.id,'proposalNumber',p.number::text,'proposalVersion',v.version,'customer',COALESCE(v.customer_snapshot,jsonb_build_object('legalName',v.customer_name,'taxId',v.customer_tax_id)),'paymentTerms',v.payment_terms,'deliveryTerms',v.delivery_terms,'notes',v.notes) AS data FROM sales_proposals p JOIN sales_proposal_versions v ON v.tenant_id=p.tenant_id AND v.proposal_id=p.id AND v.version=p.current_version WHERE p.tenant_id=$1 AND p.order_id=$2", [context.tenantId, id])).rows[0]?.data
  return { tenantId: context.tenantId, canEdit: context.permissions.includes("sales.orders.manage"), pricingOrigin: data.pricingOrigin, data, items, ...(checkout ? { checkout } : {}), ...(agreement ? { proposalAgreement: agreement } : {}) }
}
