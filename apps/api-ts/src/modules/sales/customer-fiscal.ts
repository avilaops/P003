import { Problem } from "../../platform/problem.js"

export const customerSnapshotSql = "SELECT jsonb_build_object('id',id,'revision',revision,'personType',person_type,'legalName',legal_name,'tradeName',trade_name,'taxId',tax_id,'email',email,'phone',phone,'addresses',addresses,'contacts',contacts,'fiscal',fiscal) AS data FROM parties WHERE tenant_id=$1 AND id=$2 AND is_customer AND status='active'"

export function validateFiscalCustomer(customer: Record<string, unknown>, input: { destinationState: string; taxpayer: boolean }) {
  const conflict = (message: string): never => { throw new Problem(409, "domain_conflict", message) }
  const fiscal = customer.fiscal as { taxpayerIndicator?: string; stateRegistration?: string } | null
  const taxpayer = customer.personType === "juridica" && fiscal?.taxpayerIndicator === "1" && Boolean(fiscal.stateRegistration)
  if (input.taxpayer !== taxpayer) conflict("A condição de contribuinte da cotação diverge do cadastro fiscal do cliente. Atualize o cadastro ou recalcule")
  const states = Array.isArray(customer.addresses) ? customer.addresses.map(address => (address as { state?: string }).state).filter(Boolean) : []
  if (states.length && !states.includes(input.destinationState)) conflict("A UF da cotação deve corresponder ao endereço de entrega cadastrado do cliente")
}
