import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { decimal, invitation, preview } from "../src/modules/commercial-contracts/email.js"
import { defaults, editableFields, orderNumber, validate, type Generate } from "../src/modules/commercial-contracts/model.js"
import { definitionSchema, validateDefinition, type Definition } from "../src/modules/contract-templates/definition.js"
import { definitionFromTemplate } from "../src/modules/contract-templates/import.js"
import { Problem } from "../src/platform/problem.js"

const ludus: Definition = JSON.parse(await readFile(new URL("./fixtures/ludus-contract-template.json", import.meta.url), "utf8"))
const status = (run: () => unknown) => { try { run(); return 0 } catch (error) { if (error instanceof Problem) return error.status; throw error } }

/** Modelo do portal equivalente ao documento estruturado Ludus revisado. */
function template(): any {
  return { id: 42, updated_at: "reviewed", submitters: ludus.roles.map(role => ({ name: role, uuid: role })),
    fields: ludus.fields.map(field => ({ name: field.name, type: field.kind, required: field.required, submitter_uuid: field.role })) }
}
function snapshot(count: number): any {
  const items = Array.from({ length: count }, () => ({ sku: "AC-1", name: "Equipamento", quantity: "2.500000", unit: "UN", unitPrice: "40.00", amount: "100.00", structureColor: "Branco" }))
  return { order: { id: "00000000-0000-0000-0000-000000000000", number: "42", revision: 1, status: "confirmed", amount: `${count}00.00`, dueDate: "2027-01-01" },
    company: { legalName: "Fornecedor", taxId: "documento" },
    customer: { name: "Cliente", taxId: "documento", email: "cliente@example.test", phone: "11999999999", addresses: [{ street: "Errada", primary: false },
      { street: "Rua correta", number: "12", complement: "Sala 3", district: "Centro", city: "São Paulo", state: "SP", postalCode: "01000000", primary: true }] }, items }
}
function input(tpl: any): Generate {
  const fixed: Record<string, string> = { "Data do contrato — dia": "13", "Data do contrato — mês": "novembro", "Data do contrato — ano (dois últimos dígitos)": "26",
    "Valor acordado de entrada (R$)": "0,00", "Valor remanescente (R$)": "100,00" }
  const fields = Object.fromEntries(editableFields(tpl).filter(f => f.required).map(f => [f.name as string, fixed[f.name as string] ?? "Conferido"]))
  return { orderId: "00000000-0000-0000-0000-000000000000", orderRevision: 1, templateId: 42, templateUpdatedAt: "reviewed",
    recipients: tpl.submitters.map((role: any) => ({ name: "Pessoa de teste", email: `p${role.name.length}@example.test`, role: role.name })), fields }
}

test("modelo Ludus usa endereço principal, telefone, itens indexados e moeda exata do servidor", () => {
  const tpl = template(), request = input(tpl)
  request.fields["Produto 1 — preço unitário"] = "0,01"
  request.fields["Compradora — endereço — bairro"] = "Outra cidade"
  validate(request, tpl, snapshot(1))
  for (const [name, want] of [["Compradora — endereço — logradouro e número", "Rua correta, 12, Sala 3"], ["Compradora — endereço — bairro", "Centro"],
    ["Compradora — endereço — CEP", "01000000"], ["Compradora — endereço — cidade / UF", "São Paulo / SP"], ["Telefone / WhatsApp da compradora", "11999999999"],
    ["Produto 1 — código / modelo", "AC-1"], ["Produto 1 — descrição", "Equipamento · Estrutura: Branco"], ["Produto 1 — quantidade", "2,5 UN"],
    ["Produto 1 — preço unitário", "40,00"], ["Produto 1 — preço total", "100,00"], ["pedido_total", "100,00"], ["Pedido — subtotal dos produtos", "100,00"],
    ["Pedido — descontos / acréscimos", "0,00"]]) assert.equal(request.fields[name!], want, name)
  assert.ok(!("Compradora — natureza — Pessoa jurídica" in request.fields))
})

test("modelo Ludus aceita 1 e 5 produtos, recusa 6 em vez de truncar e não deixa inventar linhas", () => {
  const tpl = template()
  for (const count of [1, 5]) { const request = input(tpl); validate(request, tpl, snapshot(count)); assert.equal(request.fields[`Produto ${count} — preço total`], "100,00") }
  assert.equal(status(() => validate(input(tpl), tpl, snapshot(6))), 409)
  const injected = input(tpl)
  injected.fields["Produto 5 — descrição"] = "Item inventado"
  validate(injected, tpl, snapshot(1))
  assert.equal(injected.fields["Produto 5 — descrição"], "")
  for (const [raw, expected] of [["10", "10 UN"], ["100", "100 UN"], ["10.000000", "10 UN"], ["0.500000", "0,5 UN"]]) {
    const state = snapshot(1); state.items[0].quantity = raw
    const request = input(tpl); validate(request, tpl, state)
    assert.equal(request.fields["Produto 1 — quantidade"], expected)
  }
})

test("entrada e saldo negociados vêm do pedido; parcelas divergentes e moeda de origem inválida são conflito", () => {
  const tpl = template(), state = snapshot(1)
  state.negotiatedPayments = { entryAmountCents: 7001, installments: [{ amountCents: 1500, dueOn: "2027-01-01" }, { amountCents: 1499, dueOn: "2027-02-01" }] }
  const request = input(tpl); validate(request, tpl, state)
  assert.equal(request.fields["Valor acordado de entrada (R$)"], "70,01")
  assert.equal(request.fields["Valor remanescente (R$)"], "29,99")
  state.negotiatedPayments.entryAmountCents = 1
  assert.equal(status(() => validate(input(tpl), tpl, state)), 409)
  const money = snapshot(1); money.items[0].unitPrice = 0.1
  assert.equal(status(() => validate(input(tpl), tpl, money)), 409)
  const large = snapshot(1); large.order.amount = large.items[0].unitPrice = large.items[0].amount = "999999999999.99"
  const big = input(tpl); validate(big, tpl, large)
  assert.equal(big.fields.pedido_total, "999.999.999.999,99")
})

test("marcações, moedas manuais e datas impossíveis são recusadas; ano bissexto é aceito", () => {
  const tpl = template()
  for (const bad of ["1.00", "R$ 1,00", "1,1", "-1,00", "1e3", "NaN", "1.00,00"]) {
    const request = input(tpl); request.fields["Logística — VALOR DO FRETE"] = bad
    assert.equal(status(() => validate(request, tpl, snapshot(1))), 422, bad)
  }
  for (const [a, b] of [["Compradora — natureza — Pessoa física", "Compradora — natureza — Pessoa jurídica"], ["Disponibilidade 1 — origem — Nacional", "Disponibilidade 1 — origem — Importado"]]) {
    const request = input(tpl); request.fields[a!] = "X"; request.fields[b!] = "X"
    assert.equal(status(() => validate(request, tpl, snapshot(1))), 422, a)
  }
  const mark = input(tpl); mark.fields["Reserva de domínio — Sim"] = "sim"
  assert.equal(status(() => validate(mark, tpl, snapshot(1))), 422)
  const feb = input(tpl); feb.fields["Data do contrato — dia"] = "31"; feb.fields["Data do contrato — mês"] = "fevereiro"
  assert.equal(status(() => validate(feb, tpl, snapshot(1))), 422)
  for (const bad of ["31/02/2027", "01/01/abcd", "01/01/0000", "2027-01-01"]) {
    const request = input(tpl); request.fields["Saldo — data de vencimento"] = bad
    assert.equal(status(() => validate(request, tpl, snapshot(1))), 422, bad)
  }
  const leap = input(tpl)
  Object.assign(leap.fields, { "Data do contrato — dia": "29", "Data do contrato — mês": "fevereiro", "Data do contrato — ano (dois últimos dígitos)": "28", "Saldo — data de vencimento": "29/02/2028" })
  validate(leap, tpl, snapshot(1))
})

test("modelo antigo mantém valores decimais e itens em texto; grupos de marcação só no documento estruturado", () => {
  const legacy = { updated_at: "reviewed", submitters: [{ name: "Compradora", uuid: "Compradora" }], fields: [
    { name: "pedido_total", type: "text", required: true, submitter_uuid: "Compradora" }, { name: "itens", type: "text", required: true, submitter_uuid: "Compradora" },
    { name: "condicoes", type: "text", required: false, submitter_uuid: "Compradora" }] }
  const request = input(legacy); request.fields.condicoes = "Livre no modelo antigo"
  validate(request, legacy, snapshot(6))
  assert.equal(request.fields.pedido_total, "600.00")
  assert.equal(request.fields.itens!.split("\n").length, 6)
  assert.equal(request.fields.condicoes, "Livre no modelo antigo")
  const fields = editableFields(template())
  assert.equal(fields.filter(f => typeof f.choiceGroup === "string").length, 42)
  const national = fields.find(f => f.name === "Disponibilidade 1 — origem — Nacional")!
  assert.deepEqual([national.choiceGroup, national.choiceOption], ["Disponibilidade 1 — origem", "Nacional"])
  assert.equal(editableFields({ fields: [{ name: "condicoes", type: "text", required: true }] })[0]!.choiceGroup, null)
})

test("padrões do contrato trazem acabamentos e preservam o identificador histórico", () => {
  assert.equal(defaults({ items: [{ name: "Equipamento", quantity: "2.000000", unit: "UN", unitPrice: "1200.00", amount: "2400.00", structureColor: "Branco", plateHolderColor: "Azul", plateHolderType: "Olímpico", upholsteryColor: "Vermelho" }] }).itens,
    "Equipamento · Estrutura: Branco · Tipo de anilheiro: Olímpico · Estofado: Vermelho | 2.000000 UN | R$ 1200.00 | R$ 2400.00")
  assert.equal(orderNumber({ order: { id: "historical-id" } }), "historical-id")
  assert.equal(decimal("1234567.89", true), "R$ 1.234.567,89")
  assert.equal(decimal("1000.250000", false), "1.000,25")
})

test("convite usa o snapshot comercial, um único link e escapa texto do cliente", () => {
  const state = { order: { id: "internal-id", number: "42", amount: "123.45", dueDate: "2026-12-01" }, company: { legalName: "Empresa" }, customer: { name: "Cliente", taxId: "123" },
    items: [{ sku: "SKU-1", name: "Produto {documents.link} [site](https://invalid.test) <b>", quantity: "2.000000", unit: "UN", unitPrice: "61.72", amount: "123.45", structureColor: "Azul", cost: "SECRET_COST" }], profit: "SECRET_PROFIT" }
  const email = invitation(state, { condicoes: "Entrada combinada" })
  assert.equal(email.message.subject, "Pedido PV-000042 e contrato para assinatura")
  const body = email.message.body
  assert.equal(body.split("{submitter.link}").length - 1, 1)
  assert.ok(body.includes("&#123;documents.link&#125;") && !body.includes("[site](https://invalid.test)") && !body.includes("<b>"))
  assert.ok(body.includes("R$ 123,45") && body.includes("Quantidade: 2 UN") && body.includes("01/12/2026") && body.includes("Entrada combinada") && body.includes("Estrutura: Azul"))
  assert.ok(!body.includes("SECRET_") && !body.includes("internal-id"))
  assert.ok(preview(state, {}).text.includes("Produto {documents.link}"))
  const accepted = invitation({ proposal: { paymentTerms: "Entrada {submitter.link}" } }, { condicoes: "Não substitui proposta aceita" }).message.body
  assert.ok(accepted.includes("Entrada &#123;submitter.link&#125;") && !accepted.includes("Não substitui"))
})

test("definição do modelo: Ludus real e 200 campos aceitos, 201 e posições fora da página recusados", () => {
  assert.equal(ludus.fields.length, 148)
  validateDefinition(definitionSchema.parse(ludus))
  const base = (): Definition => ({ name: "Contrato", pages: 1, roles: ["Cliente"], fields: [{ id: "6f1d0c7e-1111-4111-8111-111111111111", name: "cliente_nome", kind: "text", role: "Cliente", required: true, page: 1, x: 5, y: 10, width: 80, height: 5 }] })
  const many = base()
  many.fields = Array.from({ length: 200 }, (_, index) => ({ ...base().fields[0]!, id: `6f1d0c7e-1111-4111-8111-${String(index).padStart(12, "0")}`, name: `Campo ${index}` }))
  validateDefinition(many)
  many.fields.push({ ...base().fields[0]!, id: "6f1d0c7e-1111-4111-8111-999999999999", name: "Campo 201" })
  assert.equal(status(() => validateDefinition(many)), 422)
  for (const mutate of [(d: Definition) => { d.fields[0]!.width = 100 }, (d: Definition) => { d.fields[0]!.role = "Outro" }, (d: Definition) => { d.fields[0]!.x = Number.NaN },
    (d: Definition) => { d.fields.push({ ...d.fields[0]! }) }, (d: Definition) => { d.fields[0]!.fontSize = 5.9 }, (d: Definition) => { d.fields[0]!.additionalAreas = [{ page: 2, x: 1, y: 1, width: 1, height: 1 }] }]) {
    const value = base(); mutate(value)
    assert.equal(status(() => validateDefinition(value)), 422)
  }
})

test("importação preserva fonte e todas as áreas; semântica não suportada é recusada", () => {
  const area = { attachment_uuid: "pdf", page: 0, x: 0.1, y: 0.2, w: 0.3, h: 0.05 }
  const tpl: any = { name: "Modelo", schema: [{ attachment_uuid: "pdf" }], documents: [{ uuid: "pdf" }], submitters: [{ uuid: "customer", name: "Cliente" }],
    fields: [{ uuid: "6f1d0c7e-1111-4111-8111-111111111111", name: "Nome", type: "text", submitter_uuid: "customer", preferences: { font_size: "14" }, areas: [area] }] }
  const imported = definitionFromTemplate(tpl)
  assert.deepEqual([imported.fields[0]!.fontSize, imported.fields[0]!.page, imported.fields[0]!.x], [14, 1, 10])
  tpl.fields[0].areas.push(area)
  assert.equal(definitionFromTemplate(tpl).fields[0]!.additionalAreas!.length, 1)
  tpl.fields[0].readonly = true
  assert.equal(status(() => definitionFromTemplate(tpl)), 422)
})
