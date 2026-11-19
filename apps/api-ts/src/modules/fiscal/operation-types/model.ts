// F1 • Tipos de operação (equivalente ao TES). Fonte única de CFOP, tributos e efeitos operacionais.
import { z } from "zod"
import type { AuthorizedContext } from "../../../platform/access.js"
import { Problem } from "../../../platform/problem.js"
import { revisionValue, type Revision } from "../../../platform/revision.js"

export const operationPurposes = ["sale_own_production", "resale", "repair_shipment", "return", "bonus", "other"] as const
const text = (max: number) => z.string().trim().min(1).max(max).refine(v => !/[\u0000-\u001f\u007f]/.test(v))
const code = (pattern: RegExp) => z.string().regex(pattern).nullable().default(null)
const cfop = code(/^\d{4}$/)

export const operationTypeInput = z.strictObject({
  code: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,29}$/),
  name: text(60),
  direction: z.enum(["incoming", "outgoing"]),
  purpose: z.enum(operationPurposes),
  nfePurpose: z.int().min(1).max(4).default(1),
  cfopInternal: cfop,
  cfopInterstate: cfop,
  cfopForeign: cfop,
  icmsCst: code(/^\d{2}$/),
  icmsCsosn: code(/^\d{3}$/),
  ipiCst: code(/^\d{2}$/),
  pisCst: code(/^\d{2}$/),
  cofinsCst: code(/^\d{2}$/),
  ibsCbsCst: code(/^\d{3}$/),
  ibsCbsClass: code(/^\d{6}$/),
  movesStock: z.boolean(),
  generatesFinance: z.boolean(),
  generatesCommission: z.boolean(),
  requiresOrigin: z.boolean(),
  financialCategoryId: z.guid().nullable().default(null),
  isDefault: z.boolean().default(false),
  active: z.boolean().default(true),
}).superRefine((v, ctx) => {
  const prefixes = v.direction === "incoming" ? ["1", "2", "3"] : ["5", "6", "7"]
  ;[v.cfopInternal, v.cfopInterstate, v.cfopForeign].forEach((value, index) => {
    if (value && value[0] !== prefixes[index]) ctx.addIssue({ code: "custom", message: "O CFOP não corresponde ao sentido e ao destino", path: [["cfopInternal", "cfopInterstate", "cfopForeign"][index]!] })
  })
  if (v.generatesCommission && !v.generatesFinance) ctx.addIssue({ code: "custom", message: "Comissão exige financeiro", path: ["generatesCommission"] })
  if (v.purpose === "return" && (!v.requiresOrigin || v.nfePurpose !== 4)) ctx.addIssue({ code: "custom", message: "Devolução exige nota de origem e finalidade 4", path: ["purpose"] })
})
export type OperationTypeInput = z.infer<typeof operationTypeInput>
export type OperationType = OperationTypeInput & { id: string; revision: Revision; complete: boolean; missing: string[] }

const columns = `id,revision,code,name,direction,purpose,nfe_purpose,cfop_internal,cfop_interstate,cfop_foreign,icms_cst,icms_csosn,ipi_cst,pis_cst,cofins_cst,
  ibs_cbs_cst,ibs_cbs_class,moves_stock,generates_finance,generates_commission,requires_origin,financial_category_id,is_default,active`
export const operationTypeColumns = columns

/** Regime da empresa decide se o tipo precisa de CST (regime normal, CRT 3) ou CSOSN (Simples, CRT 1/2/4). */
export type TaxScope = { crt: number }

/**
 * Lista os campos que faltam para transmitir. O ERP não inventa tributação: o que estiver vazio bloqueia.
 * Rótulos em português, prontos para a mensagem de bloqueio.
 */
export function missingRules(type: OperationTypeInput, scope: TaxScope | undefined) {
  const missing: string[] = []
  if (!type.cfopInternal) missing.push("CFOP dentro do estado")
  if (!type.cfopInterstate) missing.push("CFOP fora do estado")
  if (scope?.crt === 3) {
    if (!type.icmsCst) missing.push("CST do ICMS")
    if (!type.ibsCbsCst || !type.ibsCbsClass) missing.push("CST e classificação do IBS/CBS")
  } else if (scope && !type.icmsCsosn) missing.push("CSOSN do ICMS")
  if (!scope) missing.push("perfil fiscal da empresa (CRT)")
  if (!type.pisCst) missing.push("CST do PIS")
  if (!type.cofinsCst) missing.push("CST da COFINS")
  return missing
}

export function fromRow(row: Record<string, unknown>, scope: TaxScope | undefined): OperationType {
  const data: OperationTypeInput = {
    code: String(row.code), name: String(row.name), direction: row.direction as OperationTypeInput["direction"], purpose: row.purpose as OperationTypeInput["purpose"],
    nfePurpose: Number(row.nfe_purpose), cfopInternal: row.cfop_internal as string | null, cfopInterstate: row.cfop_interstate as string | null,
    cfopForeign: row.cfop_foreign as string | null, icmsCst: row.icms_cst as string | null, icmsCsosn: row.icms_csosn as string | null,
    ipiCst: row.ipi_cst as string | null, pisCst: row.pis_cst as string | null, cofinsCst: row.cofins_cst as string | null,
    ibsCbsCst: row.ibs_cbs_cst as string | null, ibsCbsClass: row.ibs_cbs_class as string | null, movesStock: Boolean(row.moves_stock),
    generatesFinance: Boolean(row.generates_finance), generatesCommission: Boolean(row.generates_commission), requiresOrigin: Boolean(row.requires_origin),
    financialCategoryId: row.financial_category_id as string | null, isDefault: Boolean(row.is_default), active: Boolean(row.active),
  }
  const missing = missingRules(data, scope)
  return { id: String(row.id), revision: revisionValue(row.revision), ...data, complete: !missing.length, missing }
}

export async function taxScope(context: AuthorizedContext): Promise<TaxScope | undefined> {
  const row = (await context.client.query("SELECT details FROM fiscal_profiles WHERE tenant_id=$1", [context.tenantId])).rows[0]
  const crt = Number((row?.details as Record<string, unknown> | undefined)?.crt)
  return Number.isInteger(crt) && crt > 0 ? { crt } : undefined
}

export async function loadOperationType(context: AuthorizedContext, id: string, scope?: TaxScope) {
  const row = (await context.client.query(`SELECT ${columns} FROM fiscal_operation_types WHERE tenant_id=$1 AND id=$2`, [context.tenantId, id])).rows[0]
  if (!row) throw new Problem(404, "not_found", "Tipo de operação não encontrado")
  return fromRow(row, scope ?? await taxScope(context))
}

/** CFOP do cenário: mesma UF, outra UF ou exterior (UF "EX"). */
export function cfopFor(type: Pick<OperationTypeInput, "cfopInternal" | "cfopInterstate" | "cfopForeign">, issuerState: string, recipientState: string) {
  if (recipientState === "EX") return type.cfopForeign
  return recipientState === issuerState ? type.cfopInternal : type.cfopInterstate
}

/** Mensagem única de bloqueio de transmissão para um tipo incompleto ou inativo. */
export function assertTransmittable(type: OperationType) {
  if (!type.active) throw new Problem(409, "operation_type_incomplete", `O tipo de operação ${type.code} está inativo`)
  if (!type.complete) throw new Problem(409, "operation_type_incomplete", `O tipo de operação ${type.code} está incompleto: falta ${type.missing.join(", ")}. Complete o cadastro em Preferências → Fiscal → Tipos de operação`)
}

/** Efeitos operacionais de um pedido. Sem tipo informado, o pedido mantém o comportamento de venda. */
export type OrderEffects = { movesStock: boolean; generatesFinance: boolean; generatesCommission: boolean }
export const saleEffects: OrderEffects = { movesStock: true, generatesFinance: true, generatesCommission: true }
export async function orderEffects(context: AuthorizedContext, orderId: string): Promise<OrderEffects> {
  const row = (await context.client.query(`SELECT t.moves_stock,t.generates_finance,t.generates_commission FROM sales_orders o
    JOIN fiscal_operation_types t ON t.tenant_id=o.tenant_id AND t.id=o.operation_type_id WHERE o.tenant_id=$1 AND o.id=$2`, [context.tenantId, orderId])).rows[0]
  return row ? { movesStock: Boolean(row.moves_stock), generatesFinance: Boolean(row.generates_finance), generatesCommission: Boolean(row.generates_commission) } : saleEffects
}

/** Campos do rascunho de NF-e que o tipo de operação controla. */
type DraftLike = {
  operationTypeId?: string | null | undefined; sourceOrderId?: string | null | undefined; purpose?: number | undefined; returnDirection?: string | null | undefined
  referencedAccessKeys?: string[] | undefined; operationNature: string; recipient: { state: string }; model: number
  items: { cfop: string; icmsCst?: string | null | undefined; csosn?: string | null | undefined; pisCst: string; cofinsCst: string }[]
}

/**
 * Resolve o tipo de operação da nota (informado ou herdado do pedido) e aplica CFOP e CSTs aos itens.
 * Ao salvar, preenche o que o tipo define; ao transmitir, exige tipo completo e itens coerentes com ele.
 */
export async function applyOperationType(context: AuthorizedContext, draft: DraftLike, issuerState: string, transmit: boolean) {
  let id: unknown = draft.operationTypeId ?? null
  if (!id && draft.sourceOrderId) id = (await context.client.query("SELECT operation_type_id FROM sales_orders WHERE tenant_id=$1 AND id=$2", [context.tenantId, draft.sourceOrderId])).rows[0]?.operation_type_id ?? null
  if (!id) return undefined
  const type = await loadOperationType(context, String(id))
  const direction = draft.purpose === 4 && draft.returnDirection === "incoming" ? "incoming" : "outgoing"
  if (type.direction !== direction) throw new Problem(422, "invalid_input", "O tipo de operação não corresponde ao sentido da nota")
  if (type.requiresOrigin && !draft.referencedAccessKeys?.length) throw new Problem(409, "operation_type_incomplete", `O tipo de operação ${type.code} exige a chave da nota de origem`)
  const scope = await taxScope(context), cfop = cfopFor(type, issuerState, draft.recipient.state)
  if (transmit) {
    assertTransmittable(type)
    if (!cfop) throw new Problem(409, "operation_type_incomplete", `O tipo de operação ${type.code} não define CFOP para o destino ${draft.recipient.state}`)
    const coherent = draft.items.every(item => item.cfop === cfop && item.pisCst === type.pisCst && item.cofinsCst === type.cofinsCst &&
      (scope?.crt === 3 ? item.icmsCst === type.icmsCst : item.csosn === type.icmsCsosn))
    if (!coherent) throw new Problem(409, "operation_type_incomplete", `Os itens não seguem o tipo de operação ${type.code}. Salve o rascunho novamente para aplicar a regra atual`)
    return type
  }
  draft.operationTypeId = type.id
  draft.operationNature = type.name
  if (draft.model === 55) draft.purpose = type.nfePurpose
  for (const item of draft.items) {
    if (cfop) item.cfop = cfop
    if (type.pisCst) item.pisCst = type.pisCst
    if (type.cofinsCst) item.cofinsCst = type.cofinsCst
    if (scope?.crt === 3 ? type.icmsCst : type.icmsCsosn) {
      if (scope?.crt === 3) { item.icmsCst = type.icmsCst; item.csosn = null } else { item.csosn = type.icmsCsosn; item.icmsCst = null }
    }
  }
  return type
}
