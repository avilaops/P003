import { createHash } from "node:crypto"
import { z } from "zod"

import type { AuthorizedContext } from "../../platform/access.js"
import { conflict, invalid, staleRevision } from "../../platform/domain.js"
import { Problem } from "../../platform/problem.js"
import { revisionValue, type Revision } from "../../platform/revision.js"
import { loadCheckout } from "../orders/checkout.js"
import { applyDefaults, choiceMetadata, validateStructured } from "./structured.js"

type Json = any
export const MAX_FIELDS = 200
export const notFound = () => new Problem(404, "not_found", "Registro não encontrado nesta empresa")

export const generateSchema = z.strictObject({
  orderId: z.guid(),
  orderRevision: z.number().int(),
  templateId: z.number().int(),
  templateUpdatedAt: z.string(),
  recipients: z.array(z.strictObject({ role: z.string(), name: z.string(), email: z.string() })).max(100),
  fields: z.record(z.string(), z.string()),
})
export type Generate = z.infer<typeof generateSchema>
export type Recipient = Generate["recipients"][number]

export type Contract = {
  id: string; tenantId: string; customerId: string; orderId: string; templateId: number; templateName: string
  templateSnapshot: Json; snapshot: Json; recipients: Recipient[]; fields: Record<string, string>
  externalId: number | null; status: string; revision: Revision; problem: string | null; progress: Json[]
  reviewedBy: string | null; reviewedAt: string | null; sendRequestedAt: string | null; completedAt: string | null; createdAt: string
}

export const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex")
export const correlation = (tenant: string, id: string, index: number) => `erp:${tenant}:${id}:${index}`

/** Carrega e bloqueia o contrato da empresa ativa. */
export async function load(context: AuthorizedContext, id: string): Promise<Contract> {
  const row = (await context.client.query<Record<string, any>>(`SELECT id,tenant_id,customer_id,order_id,template_id::text,template_name,template_snapshot,snapshot,recipients,fields,
    external_id::text,status,revision::text,problem,progress,reviewed_by,reviewed_at::text,send_requested_at::text,completed_at::text,created_at::text
    FROM commercial_contracts WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [context.tenantId, id])).rows[0]
  if (!row) throw notFound()
  return {
    id: row.id, tenantId: row.tenant_id, customerId: row.customer_id, orderId: row.order_id, templateId: Number(row.template_id), templateName: row.template_name,
    templateSnapshot: row.template_snapshot, snapshot: row.snapshot, recipients: row.recipients, fields: row.fields,
    externalId: row.external_id === null ? null : Number(row.external_id), status: row.status, revision: revisionValue(row.revision), problem: row.problem,
    progress: row.progress, reviewedBy: row.reviewed_by, reviewedAt: row.reviewed_at, sendRequestedAt: row.send_requested_at, completedAt: row.completed_at, createdAt: row.created_at,
  }
}

/** Representação pública (sem o snapshot do modelo do provedor). */
export function publicContract({ templateSnapshot: _hidden, ...contract }: Contract) { return contract }

/** Forma que a reconciliação compartilhada com o webhook espera. */
export function forReconcile(contract: Contract) {
  return { id: contract.id, tenant_id: contract.tenantId, template_id: String(contract.templateId), recipients: contract.recipients,
    external_id: contract.externalId === null ? null : String(contract.externalId), status: contract.status, progress: contract.progress, problem: contract.problem }
}

const SNAPSHOT = `
  SELECT jsonb_build_object(
    'order',jsonb_build_object('id',o.id,'number',o.number::text,'revision',o.revision,'status',o.status,'dueDate',o.due_date::text,'amount',(o.amount_cents::numeric/100)::numeric(16,2)::text),
    'company',COALESCE(c.details,'{}'::jsonb)||jsonb_build_object('legalName',t.legal_name,'taxId',t.tax_id),
    'customer',jsonb_build_object('id',p.id,'name',p.legal_name,'taxId',p.tax_id,'email',p.email,'phone',p.phone,'addresses',p.addresses),
    'proposal',(SELECT jsonb_build_object('id',sp.id,'number',sp.number::text,'version',v.version,'paymentTerms',v.payment_terms,'deliveryTerms',v.delivery_terms,'notes',v.notes)
      FROM sales_proposals sp JOIN sales_proposal_versions v ON v.tenant_id=sp.tenant_id AND v.proposal_id=sp.id AND v.version=sp.current_version
      WHERE sp.tenant_id=o.tenant_id AND sp.order_id=o.id AND v.status='accepted'),
    'items',COALESCE((SELECT jsonb_agg(
      jsonb_build_object('name',l.name,'sku',l.sku,'unit',l.unit,'quantity',(l.quantity_micros::numeric/1000000)::numeric(24,6)::text,'unitPrice',(l.price_cents::numeric/100)::numeric(16,2)::text,'amount',(l.amount_cents::numeric/100)::numeric(16,2)::text)
      || jsonb_strip_nulls(jsonb_build_object('structureColor',l.structure_color,'swingArmColor',l.swing_arm_color,'upholsteryColor',l.upholstery_color,'plateHolderColor',l.plate_holder_color,'plateHolderType',l.plate_holder_type))
      ORDER BY l.line_number)
      FROM sales_order_lines l WHERE l.tenant_id=o.tenant_id AND l.order_id=o.id),'[]'::jsonb)) AS snapshot
  FROM sales_orders o
  JOIN parties p ON p.tenant_id=o.tenant_id AND p.id=o.customer_id
  JOIN tenants t ON t.id=o.tenant_id
  LEFT JOIN company_profiles c ON c.tenant_id=o.tenant_id
  WHERE o.tenant_id=$1 AND o.id=$2`

const money = (cents: number) => `R$ ${Math.trunc(cents / 100)},${String(Math.abs(cents % 100)).padStart(2, "0")}`
const isoDate = (raw: string) => { const parts = raw.split("-"); return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : raw }

/** Contexto comercial do pedido congelado no contrato; a negociação salva prevalece sobre o cadastro. */
export async function snapshot(context: AuthorizedContext, order: string): Promise<Json> {
  const row = (await context.client.query<{ snapshot: Json }>(SNAPSHOT, [context.tenantId, order])).rows[0]
  if (!row) throw notFound()
  const value = row.snapshot
  const checkout: Json = await loadCheckout(context, order)
  if (checkout) {
    const customer = checkout.customer as Json
    value.customer = { id: customer.id, name: customer.legalName, taxId: customer.taxId, email: customer.email, phone: customer.phone, addresses: customer.addresses }
    const payment = [checkout.entry.amountCents > 0
      ? `Entrada prevista: ${money(checkout.entry.amountCents)} · ${checkout.entry.paymentMethod?.name ?? "Forma não informada"} · ${checkout.entry.dueOn ? isoDate(checkout.entry.dueOn) : "Na geração das parcelas"}`
      : "Sem entrada negociada"]
    for (const item of checkout.installments) payment.push(`Parcela ${item.number}: ${money(item.amountCents)} · ${item.paymentMethod.name} · ${isoDate(item.dueOn)}`)
    if (checkout.paymentNotes) payment.push(checkout.paymentNotes)
    payment.push("Condições previstas; não comprovam recebimento.")
    const delivery: string[] = []
    if (checkout.manufacturingDays !== null && checkout.manufacturingDays !== undefined)
      delivery.push(checkout.entry.amountCents > 0 ? `Prazo de fabricação: ${checkout.manufacturingDays} dias após o recebimento da entrada.` : `Prazo de fabricação: ${checkout.manufacturingDays} dias (sem entrada negociada).`)
    if (checkout.deliveryNotes) delivery.push(checkout.deliveryNotes)
    value.commercialTerms = { paymentTerms: payment.join("\n"), deliveryTerms: delivery.join("\n"), notes: checkout.notes ?? "" }
    value.negotiatedPayments = { entryAmountCents: checkout.entry.amountCents, installments: checkout.installments.map((i: Json) => ({ amountCents: i.amountCents, dueOn: i.dueOn })) }
  }
  return value
}

const str = (value: unknown) => typeof value === "string" ? value : ""
const address = (value: Json) => ["street", "number", "complement", "district", "city", "state", "postalCode"].map(key => value?.[key]).filter((s): s is string => typeof s === "string" && s !== "").join(", ")

export function orderNumber(snapshot: Json) {
  const number = snapshot?.order?.number
  if (typeof number === "string" && /^[0-9]+$/.test(number)) return `PV-${number.padStart(6, "0")}`
  return typeof snapshot?.order?.id === "string" ? snapshot.order.id : "Pedido"
}

const sorted = (values: Map<string, string>) => Object.fromEntries([...values].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))

/** Valores do ERP para os campos padrão do modelo (chaves ordenadas, como no Rust). */
export function defaultValues(snapshot: Json): Map<string, string> {
  const addresses = Array.isArray(snapshot?.customer?.addresses) ? snapshot.customer.addresses : undefined
  const customerAddress = addresses?.find((a: Json) => a?.primary === true) ?? addresses?.[0]
  const items = Array.isArray(snapshot?.items) ? snapshot.items.map((item: Json) => {
    let description = str(item?.name)
    for (const [key, label] of [["structureColor", "Estrutura"], ["swingArmColor", "Braços"], ["plateHolderType", "Tipo de anilheiro"], ["upholsteryColor", "Estofado"]] as const)
      if (typeof item?.[key] === "string") description += ` · ${label}: ${item[key]}`
    return `${description} | ${str(item?.quantity)} ${str(item?.unit)} | R$ ${str(item?.unitPrice)} | R$ ${str(item?.amount)}`
  }).join("\n") : ""
  const result = new Map<string, string>()
  for (const [key, value] of [
    ["empresa_nome", snapshot?.company?.legalName], ["empresa_documento", snapshot?.company?.taxId], ["cliente_nome", snapshot?.customer?.name],
    ["cliente_documento", snapshot?.customer?.taxId], ["cliente_email", snapshot?.customer?.email], ["pedido_total", snapshot?.order?.amount],
    ["vencimento", snapshot?.order?.dueDate], ["condicoes", snapshot?.proposal?.paymentTerms], ["entrega", snapshot?.proposal?.deliveryTerms],
    ["observacoes", snapshot?.proposal?.notes],
  ] as const) result.set(key, str(value))
  result.set("empresa_endereco", address(snapshot?.company))
  result.set("cliente_endereco", customerAddress === undefined ? "" : address(customerAddress))
  result.set("itens", items)
  result.set("pedido_numero", orderNumber(snapshot))
  const terms = snapshot?.commercialTerms
  if (terms !== null && typeof terms === "object" && !Array.isArray(terms))
    for (const [field, source] of [["condicoes", "paymentTerms"], ["entrega", "deliveryTerms"], ["observacoes", "notes"]] as const) result.set(field, str(terms[source]))
  return result
}
export const defaults = (snapshot: Json) => sorted(defaultValues(snapshot))

export function editableFields(template: Json) {
  return (Array.isArray(template?.fields) ? template.fields : [])
    .filter((field: Json) => field?.type !== "signature" && field?.type !== "initials")
    .map((field: Json) => {
      const choice = typeof field?.name === "string" ? choiceMetadata(template, field.name) : undefined
      return { name: field?.name ?? null, type: field?.type ?? null, required: typeof field?.required === "boolean" ? field.required : true,
        choiceGroup: choice?.[0] ?? null, choiceOption: choice?.[1] ?? null }
    }) as { name: unknown; type: unknown; required: boolean; choiceGroup: string | null; choiceOption: string | null }[]
}

/** Valores padrão específicos do modelo: o texto histórico só muda quando o documento tem as células estruturadas. */
export function defaultsForTemplate(snapshot: Json, template: Json): Map<string, string> {
  const names = new Set(editableFields(template).map(field => field.name).filter((name): name is string => typeof name === "string"))
  const values = new Map([...defaultValues(snapshot)].filter(([name, value]) => names.has(name) && value !== ""))
  applyDefaults(snapshot, names, values)
  return values
}
export const templateDefaults = (snapshot: Json, template: Json) => sorted(defaultsForTemplate(snapshot, template))

const control = /\p{Cc}/u
export function validate(input: Generate, template: Json, snapshot: Json) {
  if (snapshot?.order?.status === "cancelled") throw conflict("Pedido cancelado não pode gerar contrato")
  if (Number(snapshot?.order?.revision) !== input.orderRevision) throw staleRevision()
  if (template?.updated_at !== input.templateUpdatedAt) throw conflict("O modelo mudou. Recarregue antes de gerar")
  const roles = template?.submitters
  if (!Array.isArray(roles)) throw invalid("Modelo sem signatários")
  const templateFields = template?.fields
  if (!Array.isArray(templateFields)) throw invalid("Modelo sem campos")
  const names = new Set<string>()
  if (!templateFields.length || templateFields.length > MAX_FIELDS || templateFields.some((f: Json) => {
    const name = f?.name
    if (typeof name !== "string" || !name || names.has(name)) return true
    names.add(name)
    return !roles.some((r: Json) => r?.uuid === f?.submitter_uuid)
  })) throw invalid("O modelo precisa de nomes de campo únicos e papéis válidos")
  if (!roles.length || roles.length > 10 || input.recipients.length !== roles.length) throw invalid("Preencha todos os destinatários do modelo")
  const seen = new Set<string>()
  for (const recipient of input.recipients) {
    recipient.name = recipient.name.trim()
    recipient.email = recipient.email.trim().replace(/[A-Z]/g, c => c.toLowerCase())
    const parts = recipient.email.split("@")
    if (!recipient.name || Buffer.byteLength(recipient.name) > 200 || control.test(recipient.name) || recipient.email.length > 254
      || !/^[\x00-\x7f]*$/.test(recipient.email) || /[\s\p{Cc}]/u.test(recipient.email) || parts.length !== 2 || parts.some(part => !part)
      || !roles.some((role: Json) => role?.name === recipient.role) || seen.has(recipient.role)) throw invalid("Destinatário inválido ou papel repetido")
    seen.add(recipient.role)
  }
  const fields = editableFields(template)
  const entries = Object.entries(input.fields)
  if (entries.length > MAX_FIELDS || entries.some(([key, value]) => Buffer.byteLength(value) > 20000 || !fields.some(f => f.name === key)))
    throw invalid("Campo desconhecido ou acima do limite")
  // Valores comerciais do ERP prevalecem; termos ausentes podem ser preenchidos e ficam no snapshot.
  for (const [key, value] of defaultsForTemplate(snapshot, template)) input.fields[key] = value
  for (const field of fields) {
    if (!["text", "date", "number", "phone", "select", "radio"].includes(typeof field.type === "string" ? field.type : ""))
      throw invalid("Modelo usa um tipo de campo ainda não suportado nesta integração")
    const value = typeof field.name === "string" && Object.hasOwn(input.fields, field.name) ? input.fields[field.name] : undefined
    if (field.required === true && (value === undefined || !value.trim())) throw invalid("Preencha os campos obrigatórios antes de gerar")
  }
  input.fields = sorted(new Map(Object.entries(input.fields)))
  validateStructured(new Map(Object.entries(input.fields)), template)
}

/** Corpo de criação no provedor: valores somente leitura, sem e-mail automático. */
export function submissionBody(contract: Contract) {
  const roles: Json[] = contract.templateSnapshot.submitters, fields: Json[] = contract.templateSnapshot.fields
  const submitters = contract.recipients.map((recipient, index) => {
    const role = roles.find(r => r?.name === recipient.role)
    const values = fields.filter(f => f?.submitter_uuid === role?.uuid && typeof f?.name === "string" && Object.hasOwn(contract.fields, f.name))
      .map(f => ({ name: f.name, default_value: contract.fields[f.name], readonly: true }))
    return { name: recipient.name, email: recipient.email, role: recipient.role, external_id: correlation(contract.tenantId, contract.id, index), send_email: false, fields: values }
  })
  return { template_id: contract.templateId, send_email: false, submitters_order: "random", submitters }
}
