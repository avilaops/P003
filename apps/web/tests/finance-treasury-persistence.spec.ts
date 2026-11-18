import { expect, test } from "@playwright/test"
import { fork, type ChildProcess } from "node:child_process"
import path from "node:path"
import { installFrontendFixture } from "./helpers/frontend-fixture"

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
    const timer = setTimeout(() => {
      cleanup()
      reject(Error("Backend de teste sem resposta"))
    }, 60000)
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
    const entries = page.getByRole("checkbox")
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
