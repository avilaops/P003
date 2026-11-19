import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import PDFDocument from "pdfkit"
import type { AuthorizedContext } from "../../platform/access.js"
import { loadOrder } from "../orders/snapshot.js"
import { loadProposal } from "../proposals/snapshot.js"

type Fields = Record<string, unknown>
const fields = (value: unknown): Fields => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {}
const text = (value: unknown) => value == null ? "" : String(value).trim()
const escape = (value: unknown) => text(value).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]!)
const asset = (path: string) => fileURLToPath(new URL("../../../../api/assets/" + path, import.meta.url))
const date = (value: unknown) => text(value).slice(0,10).replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$3/$2/$1")
const join = (v: Fields, keys: string[]) => keys.map(k => text(v[k])).filter(Boolean).join(", ")
const addressFields = ["street","number","complement","district","city","state","postalCode"]
function primary(list: unknown) {
  const entries = Array.isArray(list) ? list.map(fields) : []
  return entries.find(v => v.primary === true) ?? entries[0] ?? {}
}
function decimal(value: unknown, monetary = false) {
  const [whole = "0", raw = ""] = text(value).split(".")
  const fraction = monetary ? raw.padEnd(2,"0") : raw.replace(/0+$/, "")
  return (monetary ? "R$ " : "") + whole.replace(/\B(?=(\d{3})+(?!\d))/g,".") + (fraction ? "," + fraction : "")
}
function cents(value: number) { return decimal((BigInt(value) / 100n) + "." + String(BigInt(value) % 100n).padStart(2,"0"),true) }
function weight(items: Fields[]) {
  let sum = 0n
  for (const item of items) {
    const micros = (value: unknown) => {
      const m = /^(\d+)(?:[,.](\d{1,6}))?$/.exec(text(value).replace(/\s*kg$/i,""))
      return m ? BigInt(m[1]! + (m[2] ?? "").padEnd(6,"0")) : 0n
    }
    const kg = micros(item.equipmentWeight), quantity = micros(item.quantity)
    if (!kg || !quantity) return "Incompleto • há equipamentos sem peso válido cadastrado."
    sum += kg * quantity
  }
  return decimal((sum / 1000000000000n) + "." + String(sum % 1000000000000n).padStart(12,"0")) + " kg"
}
function rounded(value: bigint, scale: bigint, digits: number) {
  const unit = scale / 10n ** BigInt(digits)
  const digitsText = ((value + unit / 2n) / unit).toString().padStart(digits + 1, "0")
  return decimal(digitsText.slice(0, -digits) + "." + digitsText.slice(-digits))
}
// Floor area (length × width) and volume for freight quotes, from the frozen technical snapshot or the line's recorded dimensions.
function freight(items: Fields[]) {
  let area = 0n, volume = 0n
  for (const item of items) {
    const dims = fields(item.technical).dimensionsMm ?? item.equipmentDimensions
    const valid = Array.isArray(dims) && dims.length === 3 && dims.every(n => Number.isInteger(n) && n > 0 && n <= 50000)
    const m = /^(\d+)(?:[,.](\d{1,6}))?$/.exec(text(item.quantity))
    const quantity = m ? BigInt(m[1]! + (m[2] ?? "").padEnd(6,"0")) : 0n
    if (!valid || !quantity) return ["Incompleto • há equipamentos sem medidas válidas cadastradas."]
    const [length, width, height] = (dims as number[]).map(n => BigInt(n)) as [bigint, bigint, bigint]
    area += length * width * quantity
    volume += length * width * height * quantity
  }
  return ["Área ocupada • " + rounded(area, 1000000000000n, 2) + " m²", "Volume • " + rounded(volume, 1000000000000000n, 3) + " m³"]
}

const stages: Record<string,string> = { draft:"Rascunho", sent:"Enviada", accepted:"Aceita", rejected:"Rejeitada", cancelled:"Cancelado", superseded:"Substituída", confirmed:"Confirmado", completed:"Concluído" }
const finishLabels = { structureColor:"Estrutura", swingArmColor:"Braços", upholsteryColor:"Estofado", plateHolderColor:"Cor do anilheiro", plateHolderType:"Tipo de anilheiro" }
const finishes = (v: Fields) => Object.entries(finishLabels).filter(([key]) => text(v[key])).map(([key,label]) => label + " • " + text(v[key]))
function imageData(value: unknown) {
  return typeof value === "string" && value.length <= 350000 && /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : ""
}
function technical(value: unknown) {
  if (!value) return ""
  const t = fields(value), dims = t.dimensionsMm
  const dimensions = Array.isArray(dims) && dims.length === 3 && dims.every(n => Number.isInteger(n) && n > 0 && n <= 50000)
    ? dims.map(n => decimal(n)).join(" × ") + " mm" : "Dimensões não informadas"
  const photo = imageData(t.photoDataUrl)
  return (photo ? '<img alt="Foto do equipamento" width="56" height="56" style="object-fit:contain" src="' + photo + '">' : "") +
    "<div><small>" + escape(dimensions) + "<br>Peso • " + escape(t.weight || "não informado") + "<br>Bateria • " +
    escape(t.weightStack || (text(t.category).toLowerCase().includes("bateria") ? "não informada" : "não se aplica")) + "</small></div>"
}
type Section = { title: string; lines: string[] }
type Document = {
  name: string; identity: string; company: string; issuer: string[]; logo: string; customer: string[]; dates: string;
  items: Fields[]; total: string; weight?: string; freight?: string[]; sections: Section[]
}
const section = (title: string, ...lines: string[]): Section => ({ title, lines: lines.filter(Boolean) })

async function htmlDocument(d: Document) {
  const css = await readFile(asset("documents/commercial-document.css"),"utf8")
  const block = (s: Section) => '<section class="commercial-section"><h2>' + escape(s.title) +
    '</h2><div class="commercial-section-body terms">' + s.lines.map(line => "<p>" + escape(line) + "</p>").join("") + "</div></section>"
  const rows = d.items.map(item => "<tr><td>" + escape(item.name) + "<br><small>" + escape(item.sku) + "</small>" + technical(item.technical) +
    "</td><td>" + finishes(item).map(escape).join("<br>") + '</td><td class="numeric">' + escape(decimal(item.quantity) + " " + text(item.unit)) +
    '</td><td class="numeric">' + escape(decimal(item.unitPrice,true)) + '</td><td class="numeric">' + escape(decimal(item.amount,true)) + "</td></tr>").join("")
  return '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' +
    escape(d.identity) + "</title><style>" + css + '</style></head><body><article data-commercial-document class="commercial-document"><header class="commercial-document-header">' +
    (d.logo ? '<img src="' + d.logo + '" height="46" alt="">' : "") + "<p><strong>" + escape(d.company) + "</strong></p>" +
    d.issuer.map(v => "<p>" + escape(v) + "</p>").join("") + '</header><div class="commercial-document-title"><h1>' + escape(d.name) + "</h1><p>" + escape(d.identity) + "</p></div>" +
    block(section("Emitente",d.company,...d.issuer)) + block(section("Cliente",...d.customer)) + block(section("Identificação",d.dates)) +
    '<section class="commercial-section"><h2>Itens</h2><table class="commercial-document-table"><thead><tr><th>Produto</th><th>Acabamento</th><th class="numeric">Quantidade</th><th class="numeric">Unitário</th><th class="numeric">Total</th></tr></thead><tbody>' +
    rows + '</tbody></table></section><div class="commercial-document-total">Total • ' + escape(d.total) + "</div>" +
    (d.weight ? block(section("Peso bruto total",d.weight)) : "") + (d.freight?.length ? block(section("Dados para frete",...d.freight)) : "") + d.sections.map(block).join("") +
    '<footer class="commercial-document-footer">' + escape(d.identity) + " • Documento comercial • ERP Next</footer></article></body></html>"
}

function commercialPdf(d: Document) {
  const pdf = new PDFDocument({ size:"A4", margin:42, bufferPages:true, info:{ Title:d.identity, Author:d.company } })
  const chunks: Buffer[] = []
  const done = new Promise<Buffer>((resolve,reject) => {
    pdf.on("data", b => chunks.push(b)); pdf.on("end",() => resolve(Buffer.concat(chunks))); pdf.on("error",reject)
  })
  pdf.registerFont("regular",asset("fonts/NotoSans-Regular.ttf")).registerFont("bold",asset("fonts/NotoSans-Bold.ttf"))
  const width = pdf.page.width - 84
  const font = (bold = false, size = 9) => pdf.font(bold ? "bold" : "regular").fontSize(size).fillColor("#202020")
  let x = 42
  if (d.logo) {
    try { pdf.image(Buffer.from(d.logo.split(",")[1]!, "base64"), 42,42,{ fit:[62,40] }); x = 114 } catch { /* Optional legacy logo with invalid image bytes. */ }
  }
  font(true,14).text(d.company,x,42,{ width:width-x+42 })
  font(false,8).text(d.issuer.join("\n"),{ width:width-x+42 })
  pdf.y = Math.max(87,pdf.y + 8)
  pdf.moveTo(42,pdf.y).lineTo(width+42,pdf.y).strokeColor("#626262").stroke()
  pdf.moveDown().moveDown()
  font(true,16).text(d.name.toLocaleUpperCase("pt-BR"),42,pdf.y,{ width,align:"center" })
  font(false,9).text(d.identity,{ width,align:"center" }).moveDown()
  function band(title: string) {
    if (pdf.y + 45 >= pdf.page.height - 60) pdf.addPage()
    const y = pdf.y
    pdf.rect(42,y,width,17).fill("#202020")
    pdf.font("bold").fontSize(8).fillColor("#ffffff").text(title.toLocaleUpperCase("pt-BR"),49,y+3,{width:width-14})
    pdf.y = y + 22
  }
  function group(s: Section) {
    band(s.title)
    font().text(s.lines.join("\n"),48,pdf.y,{ width:width-12 }).moveDown()
  }
  group(section("Cliente",...d.customer)); group(section("Identificação",d.dates)); band(d.weight ? "Itens do pedido" : "Itens da proposta")
  const rows = d.items.map(item => [[text(item.name), "Código • " + text(item.sku), ...finishes(item)].join("\n"),
    decimal(item.quantity) + " " + text(item.unit), decimal(item.unitPrice,true), decimal(item.amount,true)])
  font(false,8)
  pdf.table({ position:{x:42,y:pdf.y}, maxWidth:width, columnStyles:[width-215,65,75,75],
    rowStyles: index => index === 0 ? { backgroundColor:"#f4f4f4", font:{src:"bold",size:8} } : {},
    defaultStyle:{ padding:5, border:[0,0,0.5,0], borderColor:"#d6d6d6" },
    data:[["Produto","Quantidade","Unitário","Total"],...rows] })
  pdf.moveDown()
  group(section(d.weight ? "Total do pedido" : "Total da proposta",d.total))
  if (d.weight) group(section("Peso bruto total",d.weight))
  if (d.freight?.length) group(section("Dados para frete",...d.freight))
  for (const s of d.sections) group(s)
  const pages = pdf.bufferedPageRange().count
  for (let i = 0; i < pages; i++) {
    pdf.switchToPage(i)
    pdf.page.margins.bottom = 0
    const y = pdf.page.height - 29
    pdf.moveTo(42,y-8).lineTo(42+width,y-8).strokeColor("#d6d6d6").stroke()
    font(false,7).text(d.identity + " • Documento comercial",42,y,{ width:width-90 })
    pdf.text("Página " + (i+1) + " de " + pages,width-48,y,{ width:90, align:"right" })
  }
  pdf.end()
  return done
}

function proposalDocument(proposal: Awaited<ReturnType<typeof loadProposal>>, header: Pick<Document,"company" | "issuer" | "logo">): Document {
  const { data,items } = proposal
  const status = data.expired ? "Expirada" : data.status === "cancelled" ? "Cancelada" : stages[text(data.status)] ?? "Não informado"
  return { ...header, name:"Proposta comercial", identity:"Proposta " + data.number + " • Versão " + data.version + " • " + status,
    customer:[text(data.customerName),"CPF/CNPJ • " + text(data.customerTaxId)], dates:"Emissão • " + date(data.createdAt) + " • Validade • " + date(data.validUntil),
    items, total:decimal(data.amount,true),
    freight:["Peso bruto total • " + weight(items.map(item => ({ ...item, equipmentWeight: fields(item.technical).weight }))), ...freight(items)],
    sections:[section("Condições de pagamento",text(data.paymentTerms)),
      section("Condições de entrega",text(data.deliveryTerms)), section("Observações",text(data.notes))].filter(s => s.lines.length) }
}

export function acceptedProposalPdf(proposal: Awaited<ReturnType<typeof loadProposal>>, company: { legalName: string; taxId?: string }) {
  return commercialPdf(proposalDocument(proposal, { company: company.legalName, issuer: company.taxId ? ["CPF/CNPJ • " + company.taxId] : [], logo: "" }))
}

export async function salesMailDocument(context: AuthorizedContext, kind: "order" | "proposal", id: string) {
  const company = (await context.client.query("SELECT t.legal_name,t.tax_id,p.details FROM tenants t LEFT JOIN company_profiles p ON p.tenant_id=t.id WHERE t.id=$1",[context.tenantId])).rows[0]!
  const profile = fields(company.details)
  const header = { company:text(company.legal_name), issuer:["CPF/CNPJ • " + text(company.tax_id),join(profile,addressFields),join(profile,["phone","email","website"])].filter(Boolean), logo:imageData(profile.logoDataUrl) }
  if (kind === "proposal") {
    const proposal = await loadProposal(context,id)
    const { data } = proposal
    const html = await htmlDocument(proposalDocument(proposal,header))
    return { html, attachment:{ filename:"proposta-" + data.number + "-v" + data.version + ".html",contentType:"text/html; charset=utf-8",content:Buffer.from(html) } }
  }
  const { data,items,checkout,proposalAgreement } = await loadOrder(context,id)
  const agreement = fields(proposalAgreement)
  const customer = checkout?.customer ?? (agreement.customer ? fields(agreement.customer) : (await context.client.query(
    "SELECT email,phone,addresses,contacts FROM parties WHERE tenant_id=$1 AND id=$2",[context.tenantId,data.customerId])).rows[0] ?? {})
  const contact = join(primary(customer.contacts),["name","phone","email"])
  const customerLines = [text(customer.legalName || data.customerName), "CPF/CNPJ • " + text(customer.taxId || data.customerTaxId),
    join(primary(customer.addresses),addressFields), text(customer.email),text(customer.phone),contact && "Contato • " + contact,
    checkout?.stateRegistration && "Inscrição estadual • " + checkout.stateRegistration].filter((line): line is string => !!line)
  const sections: Section[] = []
  if (checkout) {
    const entry = checkout.entry
    sections.push(section("Pagamento previsto",entry.amountCents ? "Entrada prevista • " + cents(entry.amountCents) + " • " + (entry.paymentMethod?.name ?? "Forma não informada") + " • " + (entry.dueOn ? date(entry.dueOn) : "Na geração das parcelas") : "Sem entrada negociada",
      ...checkout.installments.map(i => "Parcela " + i.number + " • " + cents(i.amountCents) + " • " + i.paymentMethod.name + " • " + date(i.dueOn)),text(checkout.paymentNotes),"Condições previstas. Este documento não comprova recebimento."))
    sections.push(section("Entrega",checkout.manufacturingDays == null ? "" : "Prazo de fabricação • " + text(checkout.manufacturingDays) + (entry.amountCents ? " dias após o recebimento da entrada." : " dias (sem entrada negociada)."),text(checkout.deliveryNotes)),section("Observações",text(checkout.notes)))
  } else {
    sections.push(section("Pagamento previsto",text(agreement.paymentTerms) || "Condições de pagamento não registradas. Este documento não comprova recebimento."),
      section("Entrega",text(agreement.deliveryTerms)),section("Observações",text(agreement.notes)))
  }
  const number = "PV-" + data.number.replace(/^PV-/,"").padStart(6,"0")
  const d: Document = { ...header, name:"Pedido de venda", identity:number + " • Revisão " + data.revision + " • " + (data.status === "accepted" ? "Encomenda aceita" : stages[text(data.status)] ?? "Não informado"),
    dates:"Vencimento • " + date(data.dueDate),customer:customerLines,items,total:decimal(data.amount,true),weight:weight(items),freight:freight(items),sections:sections.filter(s => s.lines.length) }
  const html = await htmlDocument(d)
  return { html, attachment:{ filename:"pedido-" + number + "-r" + data.revision + ".pdf",contentType:"application/pdf",content:await commercialPdf(d) } }
}

export function preservedOrderPdf(snapshot: Fields) {
  const order = fields(snapshot.order), company = fields(snapshot.company), customer = fields(snapshot.customer)
  const terms = fields(snapshot.commercialTerms ?? snapshot.proposal)
  const contacts = (party: Fields) => [text(party.taxId) && "CPF/CNPJ • " + text(party.taxId), text(party.email), text(party.phone),
    join(primary(party.addresses), addressFields), join(party, addressFields)].filter(Boolean)
  return commercialPdf({
    name: "Pedido de venda", identity: text(order.number) + " • Revisão " + text(order.revision) + " • Cópia preservada no contrato",
    company: text(company.legalName), issuer: contacts(company), logo: imageData(company.logoDataUrl),
    customer: [text(customer.name), ...contacts(customer)], dates: "Vencimento • " + date(order.dueDate),
    items: Array.isArray(snapshot.items) ? snapshot.items.map(fields) : [], total: decimal(order.amount, true),
    weight: "Não informado no documento preservado",
    sections: [section("Pagamento previsto", text(terms.paymentTerms)), section("Entrega", text(terms.deliveryTerms)),
      section("Observações", text(terms.notes))].filter(s => s.lines.length),
  })
}
