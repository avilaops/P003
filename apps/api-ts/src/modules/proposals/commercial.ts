import type { AuthorizedContext } from "../../platform/access.js"
import { canonicalJson } from "../../platform/json.js"
import { Problem } from "../../platform/problem.js"
import { prepareMixed } from "../commercial/mixed-prepare.js"
import type { ProposalInput } from "./schema.js"

function conflict(message: string): never { throw new Problem(409, "domain_conflict", message) }
export const customerSnapshotSql = "SELECT jsonb_build_object('id',id,'revision',revision,'personType',person_type,'legalName',legal_name,'tradeName',trade_name,'taxId',tax_id,'email',email,'phone',phone,'addresses',addresses,'contacts',contacts,'fiscal',fiscal) AS data FROM parties WHERE tenant_id=$1 AND id=$2 AND is_customer AND status='active'"

export async function prepareProposalCommercial(context: AuthorizedContext, input: ProposalInput) {
  const { client, tenantId } = context
  if (!input.commercial) {
    const published = (await client.query("SELECT EXISTS(SELECT 1 FROM price_table_items i JOIN commercial_settings s ON s.tenant_id=i.tenant_id AND s.active_price_version_id=i.version_id WHERE i.tenant_id=$1 AND i.product_id=ANY($2::uuid[])) AS present", [tenantId, input.items.map(item => item.productId)])).rows[0]?.present
    if (published) conflict("Use a cotação comercial atualizada para os equipamentos da tabela publicada")
    return null
  }
  const prepared = await prepareMixed(context, input.commercial.simulation)
  if (prepared.digest !== input.commercial.digest) throw new Problem(412, "revision_conflict", "A cotação mudou. Recalcule antes de salvar a proposta")
  const customer = (await client.query<{ data: Record<string, unknown> }>(customerSnapshotSql, [tenantId, input.customerId])).rows[0]?.data
  if (!customer) conflict("Selecione um cliente ativo desta empresa")
  validateFiscalCustomer(customer, input.commercial.simulation)
  return {
    prepared, customer,
    public: { kind: "mixed", input: input.commercial.simulation, sale: prepared.sale, digest: prepared.digest, customerRevision: customer.revision, personType: customer.personType },
    private: { director: prepared.director, rules: prepared.rules, policies: prepared.policies, sources: prepared.sources },
  }
}

export function validateFiscalCustomer(customer: Record<string, unknown>, input: { destinationState: string; taxpayer: boolean }) {
  const fiscal = customer.fiscal as { taxpayerIndicator?: string; stateRegistration?: string } | null
  const taxpayer = customer.personType === "juridica" && fiscal?.taxpayerIndicator === "1" && Boolean(fiscal.stateRegistration)
  if (input.taxpayer !== taxpayer) conflict("A condição de contribuinte da cotação diverge do cadastro fiscal do cliente. Atualize o cadastro ou recalcule")
  const states = Array.isArray(customer.addresses) ? customer.addresses.map(address => (address as { state?: string }).state).filter(Boolean) : []
  if (states.length && !states.includes(input.destinationState)) conflict("A UF da cotação deve corresponder ao endereço de entrega cadastrado do cliente")
}

type ProposalLine = { productId: string; quantity: bigint; price: bigint; amount: bigint; structure: string | null; swing: string | null; holderColor: string | null; holderType: string | null; upholstery: string | null }
export function verifyProposalCommercialLines(quote: NonNullable<Awaited<ReturnType<typeof prepareProposalCommercial>>>, lines: ProposalLine[], total: bigint) {
  if (BigInt(quote.prepared.sale.totalCents) !== total || lines.length !== quote.prepared.sale.items.length) conflict("Os itens e valores da proposta divergem da cotação. Recalcule")
  for (const line of lines) {
    const item = quote.prepared.sale.items.find(item => item.productId === line.productId)
    if (!item || BigInt(item.quantity) * 1000000n !== line.quantity || BigInt(item.unitTotalCents) !== line.price || BigInt(item.totalCents) !== line.amount ||
      (item.structureColor || null) !== line.structure || (item.swingArmColor || null) !== line.swing ||
      (item.plateHolderColor || null) !== line.holderColor || (item.plateHolderType || null) !== line.holderType || (item.upholsteryColor || null) !== line.upholstery) conflict("Os produtos, quantidades, preços ou acabamentos divergem da cotação. Recalcule")
  }
}

export async function captureTechnical(context: AuthorizedContext, productId: string) {
  return (await context.client.query<{ data: Record<string, unknown> }>("SELECT jsonb_build_object('revision',c.revision,'dimensionsMm',c.dimensions_mm,'weight',c.weight,'weightStack',c.weight_stack,'category',c.technical_category,'description',c.description,'manufacturer',c.manufacturer,'manufacturerModel',c.manufacturer_model,'sources',c.catalog_sources,'photoDataUrl',p.photo_data_url,'photoUrl',CASE WHEN c.main_media_id IS NOT NULL THEN '/api/erp/products/'||p.id||'/media/'||c.main_media_id ELSE NULL END) AS data FROM product_catalog_profiles c JOIN products p ON p.tenant_id=c.tenant_id AND p.id=c.product_id WHERE c.tenant_id=$1 AND c.product_id=$2", [context.tenantId, productId])).rows[0]?.data ?? null
}

export function sameSnapshot(left: unknown, right: unknown) { return canonicalJson(left) === canonicalJson(right) }
