import { expect, test } from "@playwright/test"
import { fork, type ChildProcess } from "node:child_process"
import path from "node:path"
import { installFrontendFixture } from "./helpers/frontend-fixture"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"

type Ready = { ready: boolean; tenant: string; account: string; party: string; access: string }
type Snapshot = {
  items: number
  paid: number
  receipts: number
  matches: number
  matched: number
  net: string
  charged: number
  reference: string
  paymentId: string
  reportDownloads: number
  importedReports: number
}
function message<T>(child: ChildProcess, command?: string) {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      child.off("message", reply)
      child.off("exit", exit)
    }
    const reply = (v: unknown) => {
      cleanup()
      if (v && typeof v === "object" && "error" in v) reject(Error(String(v.error)))
      else resolve(v as T)
    }
    const exit = (code: number | null) => {
      cleanup()
      reject(Error("Backend de teste encerrado • " + code))
    }
    const timer = setTimeout(
      () => {
        cleanup()
        reject(Error("Backend de teste sem resposta"))
      },
      command ? 60000 : 180000,
    )
    child.once("message", reply)
    child.once("exit", exit)
    if (command) child.send({ command })
  })
}

test("Chromium • agrupamento, cobrança Pix, webhook, retorno e conciliação no PostgreSQL", async ({
  context,
  page,
  baseURL,
}) => {
  test.setTimeout(420_000)
  test.skip(!process.env.API_TS_TEST_ADMIN_URL, "Defina API_TS_TEST_ADMIN_URL para um PostgreSQL de testes descartável")
  const api = path.resolve(process.cwd(), "../api-ts")
  const backend = fork(path.join(api, "test/treasury-browser-backend.ts"), [], {
    cwd: api,
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  })
  try {
    const ready = await message<Ready>(backend)
    await installFrontendFixture(context, baseURL, ready.tenant, ready.access)
    await context.unroute("**/api/erp/**")
    const submitted = (p: string) =>
      page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/erp/" + p, {
        timeout: 60000,
      })
    await page.goto("/financeiro")
    const receivables = page.getByRole("link", { name: /^A receber\s+R\$\s*100,00$/ })
    await expect(receivables).toBeVisible({ timeout: 40000 })
    await receivables.click()
    await expect(page.getByRole("table", { name: "Títulos do filtro" }).getByRole("row")).toHaveCount(3, {
      timeout: 40000,
    })
    await page.goto("/financeiro/faturamento-agrupado?partyId=" + ready.party)
    const titles = page.getByRole("checkbox", { name: /Selecionar A receber/ })
    await expect(titles).toHaveCount(2, { timeout: 40000 })
    await titles.nth(0).check()
    await titles.nth(1).check()
    await page.getByRole("textbox", { name: "Referência ou motivo" }).fill("Agrupamento de aceite")
    await page.getByLabel("Vencimento da cobrança").fill("2027-03-01")
    const group = submitted("finance/operations")
    await page.getByRole("button", { name: "Confirmar operação" }).click()
    const groupResponse = await group
    expect(groupResponse.ok(), await groupResponse.text()).toBeTruthy()
    await page.getByRole("link", { name: "Emitir ou consultar cobrança do grupo" }).click()
    await expect(page.getByText("Vencimento • 2027-03-01")).toBeVisible({ timeout: 40000 })
    const issued = submitted("finance-treasury/issue-charge")
    await page.getByRole("button", { name: "Emitir cobrança de teste" }).click()
    const issueResponse = await issued
    expect(issueResponse.ok(), await issueResponse.text()).toBeTruthy()
    await expect(page.getByRole("textbox", { name: "Pix copia e cola" })).toHaveValue("TESTE-PIX-100")
    expect(await message<{ status: number }>(backend, "approve")).toEqual({ status: 200 })
    expect(await message<{ status: number }>(backend, "approve")).toEqual({ status: 200 })
    const before = await message<Snapshot>(backend, "snapshot")
    expect(before).toMatchObject({ charged: 1, items: 2, paid: 2, receipts: 2, net: "9800", matches: 0 })
    const csv =
      "EXTERNAL_REFERENCE;SOURCE_ID;USER_ID;TRANSACTION_TYPE;TRANSACTION_AMOUNT;TRANSACTION_CURRENCY;SETTLEMENT_NET_AMOUNT\r\n" +
      before.reference +
      ";" +
      before.paymentId +
      ";77;SETTLEMENT;100.00;BRL;98.00"
    await page
      .getByLabel(/Relatório Dinheiro em conta/)
      .setInputFiles({ name: "retorno.csv", mimeType: "text/csv", buffer: Buffer.from(csv) })
    const returned = submitted("finance-treasury/import-return")
    await page.getByRole("button", { name: "Conferir retorno" }).click()
    const report = await returned
    expect(report.ok(), await report.text()).toBeTruthy()
    await page.getByRole("button", { name: "Consultar relatórios no Mercado Pago" }).click()
    await page.getByLabel("Arquivo do vendedor").selectOption("881")
    for (let attempt = 0; attempt < 2; attempt++) {
      const importing = submitted("finance-treasury/import-return")
      await page.getByRole("button", { name: "Importar arquivo selecionado" }).click()
      const imported = await importing
      expect(imported.ok(), await imported.text()).toBeTruthy()
    }
    expect(await message<Snapshot>(backend, "snapshot")).toMatchObject({
      importedReports: 1,
      reportDownloads: 1,
      receipts: 2,
      net: "9800",
    })
    const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(new Date()),
      compact = date.replaceAll("-", "")
    const statement =
      "<OFX><STMTRS><CURDEF>BRL<BANKACCTFROM><BANKID>364<ACCTID>12345</BANKACCTFROM><BANKTRANLIST><DTSTART>" +
      compact +
      "<DTEND>" +
      compact +
      "<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>" +
      compact +
      "<TRNAMT>98.00<FITID>LOTE-98<NAME>Liquidação Pix agrupada</STMTTRN></BANKTRANLIST><LEDGERBAL><BALAMT>98.00<DTASOF>" +
      compact +
      "</LEDGERBAL></STMTRS></OFX>"
    await page.goto("/financeiro/caixas-bancos?accountId=" + ready.account)
    await expect(page.getByLabel("Arquivo do banco")).toBeVisible({ timeout: 40000 })
    await page
      .getByLabel("Arquivo do banco")
      .setInputFiles({ name: "extrato.ofx", mimeType: "text/plain", buffer: Buffer.from(statement) })
    const imported = submitted("finance-treasury/import-ofx")
    await page.getByRole("button", { name: "Importar extrato" }).click()
    const ofx = await imported
    expect(ofx.ok(), await ofx.text()).toBeTruthy()
    await page.getByRole("radio", { name: /Liquidação Pix agrupada/ }).check()
    const entries = page.getByRole("region", { name: "Movimentos do ERP disponíveis" }).getByRole("checkbox")
    await expect(entries).toHaveCount(3)
    for (let i = 0; i < 3; i++) await entries.nth(i).check()
    const matched = submitted("finance-treasury/match")
    await page.getByRole("button", { name: "Conciliar 3 movimento(s)" }).click()
    const match = await matched
    expect(match.ok(), await match.text()).toBeTruthy()
    await expect(page.getByText(/LOTE-98 • Conciliado/)).toBeVisible()
    expect(await message<Snapshot>(backend, "snapshot")).toMatchObject({
      charged: 1,
      items: 2,
      paid: 2,
      receipts: 2,
      net: "9800",
      matches: 3,
      matched: 1,
    })
  } finally {
    if (backend.connected) {
      const ended = new Promise((resolve) => backend.once("exit", resolve))
      backend.send({ command: "stop" })
      await ended
    }
  }
})

test("Chromium • comando de envio preserva no PDF todos os 105 títulos filtrados da carteira", async ({
  context,
  page,
  baseURL,
}) => {
  test.setTimeout(420_000)
  test.skip(!process.env.API_TS_TEST_ADMIN_URL, "Requer PostgreSQL de testes descartável")
  const api = path.resolve(process.cwd(), "../api-ts")
  const backend = fork(path.join(api, "test/treasury-browser-backend.ts"), [], {
    cwd: api,
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  })
  try {
    const ready = await message<Ready>(backend)
    const { ids } = await message<{ ids: string[] }>(backend, "seedReport")
    await installFrontendFixture(context, baseURL, ready.tenant, ready.access)
    await context.unroute("**/api/erp/**")
    await page.goto("/relatorios/financeiro?side=receivable")
    await page.getByLabel("Contraparte", { exact: true }).fill("selecionado")
    await expect(page.getByText(/105 títulos • posição em/)).toBeVisible({ timeout: 40000 })
    await expect(page.getByRole("table", { name: "Títulos do filtro" }).getByRole("row")).toHaveCount(31)
    await page.getByRole("button", { name: "Próxima" }).click()
    const [preview, identity] = await Promise.all([
      page.waitForResponse(r => r.request().method() === "GET" && new URL(r.url()).pathname === "/api/erp/financial-report/email"),
      page.waitForResponse(r => r.request().method() === "GET" && new URL(r.url()).pathname === "/api/erp/me"),
      page.getByRole("button", { name: "Enviar por e-mail", exact: true }).click(),
    ])
    for (const res of [preview, identity]) {
      const url = new URL(res.url())
      const wire = { path: url.pathname + url.search, status: res.status(), etag: res.headers()["etag"],
        backend: res.headers()["x-erp-backend"], contentType: res.headers()["content-type"], body: await res.text() }
      await test.info().attach(url.pathname.split("/").pop()! + ".json", {
        body: JSON.stringify(wire), contentType: "application/json",
      })
      expect(res.ok(), JSON.stringify(wire)).toBeTruthy()
      expect(wire.backend).toBe("typescript")
    }
    expect(Object.fromEntries(new URL(preview.url()).searchParams)).toEqual({ side: "receivable", q: "selecionado" })
    expect((await preview.json()).tenantId).toBe(ready.tenant)
    expect((await identity.json()).tenant.id).toBe(ready.tenant)
    const dialog = page.getByRole("dialog")
    await expect(dialog).toContainText("105 registro(s)", { timeout: 40000 })
    await expect(dialog).toContainText("Empresa piloto • posição em")
    await expect(dialog).toContainText("A receber • R$ 12.962,25")
    await dialog.getByLabel("Destinatário").fill("financeiro@example.test")
    const sent = page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith("/financial-report/email"),
    )
    await dialog.getByRole("button", { name: "Enviar e-mail com anexo" }).click()
    const response = await sent
    expect(response.ok(), await response.text()).toBeTruthy()
    expect(response.request().postDataJSON().filters).toEqual({ side: "receivable", q: "selecionado" })
    await expect(dialog).toContainText("Aceito pelo servidor de e-mail")
    type Mail = { id: string; to: string; attachments: { content: string; filename: string }[] }
    type Delivery = {
      id: string
      pdf: string
      snapshot: { rows: { id: string }[]; totals: { receivable: string }; asOf: string }
    }
    const evidence = await message<{ deliveries: Delivery[]; messages: Mail[] }>(backend, "reportMail")
    expect(evidence.deliveries).toHaveLength(1)
    expect(evidence.messages).toHaveLength(1)
    const delivery = evidence.deliveries[0]!,
      mail = evidence.messages[0]!
    expect(mail.id).toBe(delivery.id)
    expect(mail.to).toBe("financeiro@example.test")
    expect(delivery.snapshot.totals.receivable).toBe("12962.25")
    expect(delivery.snapshot.rows.map((r) => r.id).sort()).toEqual(ids.sort())
    expect(mail.attachments[0]!.content).toBe(delivery.pdf.replace(/\s+/g, ""))
    const require = createRequire(path.join(process.cwd(), "package.json"))
    const pdfModule = pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.mjs")).href
    const { getDocument } = (await import(pdfModule)) as typeof import("pdfjs-dist")
    const task = getDocument({
      data: new Uint8Array(Buffer.from(mail.attachments[0]!.content, "base64")),
      useSystemFonts: true,
    })
    const pdf = await task.promise
    const pages: string[] = []
    for (let n = 1; n <= pdf.numPages; n++) {
      const text = await (await pdf.getPage(n)).getTextContent()
      pages.push(text.items.map((item) => ("str" in item ? item.str : "")).join(" "))
    }
    const contents = pages.join(" ")
    expect(contents).toContain("Empresa piloto")
    expect(contents).toContain(delivery.snapshot.asOf.split("-").reverse().join("/"))
    expect(contents).toContain("12.962,25")
    expect(contents).not.toContain("Cliente de teste")
    for (const id of ids) expect(contents).toContain(id)
    await task.destroy()
  } finally {
    if (backend.connected) {
      const ended = new Promise((resolve) => backend.once("exit", resolve))
      backend.send({ command: "stop" })
      await ended
    }
  }
})

test("Chromium • borderô sem provedor preserva dois clientes, exporta conferência e cancela sem cobrança", async ({
  context,
  page,
  baseURL,
}) => {
  test.setTimeout(420_000)
  test.skip(!process.env.API_TS_TEST_ADMIN_URL, "Requer PostgreSQL descartável")
  const api = path.resolve(process.cwd(), "../api-ts")
  const backend = fork(path.join(api, "test/treasury-browser-backend.ts"), [], {
    cwd: api,
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  })
  try {
    const ready = await message<Ready>(backend)
    const { title } = await message<{ title: string }>(backend, "seedBatch")
    await installFrontendFixture(context, baseURL, ready.tenant, ready.access)
    await context.unroute("**/api/erp/**")
    await page.goto("/financeiro/remessas-retornos")
    await page.getByRole("button", { name: "Preparar ou consultar borderô" }).click()
    await page.getByLabel("Conta do borderô").selectOption(ready.account)
    await page.getByLabel("Referência do borderô").fill("Conferência regional")
    await page.getByRole("checkbox", { name: /Cliente de teste.*40,00/ }).check()
    await page.getByRole("checkbox", { name: /Cliente do borderô.*90,50/ }).check()
    await page.getByRole("button", { name: "Preparar borderô", exact: true }).click()
    await expect(page.getByText("Para emitir, vincule esta conta a um provedor de cobrança.")).toBeVisible({
      timeout: 40000,
    })
    const promise = page.waitForEvent("download")
    await page.getByRole("button", { name: "Exportar conferência CSV" }).click()
    const downloaded = await promise,
      stream = await downloaded.createReadStream()
    const chunks: Buffer[] = []
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk))
    const csv = Buffer.concat(chunks).toString("utf8")
    expect(csv).toContain(title)
    expect(csv).toContain("Cliente de teste")
    expect(csv).toContain("90,50")
    await page.getByLabel("Motivo do cancelamento").fill("Refazer seleção")
    await page.getByRole("button", { name: "Cancelar borderô e liberar títulos" }).click()
    await expect(page.getByText(/Cancelado em.*Refazer seleção/)).toBeVisible({ timeout: 40000 })
    const snapshot = await message<{ audit: unknown[] }>(backend, "batchSnapshot")
    expect(snapshot.audit).toEqual([
      {
        reference: "Conferência regional",
        cancelled: true,
        reason: "Refazer seleção",
        count: 2,
        parties: 2,
        cents: "13050",
        released: 2,
        charges: 0,
      },
    ])
  } finally {
    if (backend.connected) {
      const ended = new Promise((resolve) => backend.once("exit", resolve))
      backend.send({ command: "stop" })
      await ended
    }
  }
})
