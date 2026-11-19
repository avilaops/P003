// Um convite leva o pedido comercial e o link de assinatura do contrato.
// Todo valor vem do snapshot imutável do contrato, nunca do pedido de envio.
import { orderNumber } from "./model.js"

type Json = any
export type ContractEmail = { subject: string; text: string }
const FINISHES = [["structureColor", "Estrutura"], ["swingArmColor", "Braços"], ["plateHolderType", "Tipo de anilheiro"], ["upholsteryColor", "Estofado"]] as const
const str = (value: unknown) => typeof value === "string" ? value : ""

/** Escapa Markdown e a sintaxe de variáveis do e-mail do provedor: texto do cliente não cria outro link. */
export function literal(value: string) {
  let text = ""
  for (const character of value) {
    if (character === "&") text += "&amp;"
    else if (character === "<") text += "&lt;"
    else if (character === ">") text += "&gt;"
    else if (character === "{") text += "&#123;"
    else if (character === "}") text += "&#125;"
    else if ("\\`*_[]()#+-!|".includes(character)) text += "\\" + character
    else if (character === "\r") continue
    else if (character !== "\n" && /\p{Cc}/u.test(character)) text += " "
    else text += character
  }
  return text
}

export function decimal(value: unknown, money: boolean) {
  const raw = str(value)
  const dot = raw.indexOf(".")
  const integer = dot < 0 ? raw : raw.slice(0, dot)
  let fraction = dot < 0 ? "" : raw.slice(dot + 1)
  let grouped = ""
  ;[...integer].forEach((digit, index) => { if (index > 0 && (integer.length - index) % 3 === 0) grouped += "."; grouped += digit })
  if (!money) fraction = fraction.replace(/0+$/, "")
  if (fraction) grouped += "," + fraction
  return money ? `R$ ${grouped}` : grouped
}

function dueDate(snapshot: Json) {
  const raw = str(snapshot?.order?.dueDate)
  const parts = raw.split("-")
  return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : raw
}

function contents(snapshot: Json, fields: Json, escape: boolean) {
  const text = (value: string) => escape ? literal(value) : value
  const string = (value: unknown) => text(str(value))
  const sections = [
    `Pedido ${orderNumber(snapshot)}`,
    `Empresa: ${string(snapshot?.company?.legalName)}`,
    `Cliente: ${string(snapshot?.customer?.name)}`,
    `Documento do cliente: ${string(snapshot?.customer?.taxId)}`,
    "Itens do pedido:",
  ]
  for (const item of Array.isArray(snapshot?.items) ? snapshot.items : []) {
    sections.push(`${string(item?.sku)} · ${string(item?.name)}\nQuantidade: ${text(decimal(item?.quantity, false))} ${string(item?.unit)}\nUnitário: ${text(decimal(item?.unitPrice, true))} · Total: ${text(decimal(item?.amount, true))}`)
    for (const [key, label] of FINISHES) { const color = str(item?.[key]); if (color) sections.push(`${label}: ${text(color)}`) }
  }
  sections.push(`Total do pedido: ${text(decimal(snapshot?.order?.amount, true))}`)
  sections.push(`Vencimento: ${text(dueDate(snapshot))}`)
  for (const [key, source, label] of [["condicoes", "paymentTerms", "Condições comerciais"], ["entrega", "deliveryTerms", "Condições de entrega"], ["observacoes", "notes", "Observações comerciais"]] as const) {
    // Parcelas negociadas e propostas aceitas prevalecem mesmo sem o campo no PDF.
    const filled = (value: unknown) => typeof value === "string" && value.trim() ? value : undefined
    const value = filled(snapshot?.commercialTerms?.[source]) ?? filled(snapshot?.proposal?.[source]) ?? filled(fields?.[key])
    if (value) sections.push(`${label}: ${text(value)}`)
  }
  return sections.join("\n\n")
}

export function preview(snapshot: Json, fields: Json): ContractEmail {
  return {
    subject: `Pedido ${orderNumber(snapshot)} e contrato para assinatura`,
    text: `${contents(snapshot, fields, false)}\n\nO e-mail inclui o link individual para revisar e assinar o contrato.`,
  }
}

export function invitation(snapshot: Json, fields: Json) {
  return {
    send_email: true,
    message: {
      subject: preview(snapshot, fields).subject,
      body: `Olá.\n\n${contents(snapshot, fields, true)}\n\nRevise o pedido e o contrato antes de assinar.\n\n[Abrir contrato e assinar]({submitter.link})`,
    },
  }
}
