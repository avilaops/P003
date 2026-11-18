import assert from "node:assert/strict"

export const testAgreement = {
  taxId: "04252011000110",
  name: "EMPRESA TESTE",
  transmissionCode: "123456789012345",
  beneficiaryCode: "001234567",
  agency: "4321",
  agencyDigit: "0",
  account: "000023456",
  accountDigit: "1",
}
const pad = (n: string | number, size: number) => String(n).padStart(size, "0")

function record(fields: [number, string][]) {
  const chars = Array<string>(240).fill(" ")
  for (const [position, text] of fields) {
    assert.ok(position >= 1 && position + text.length <= 241)
    chars.splice(position - 1, text.length, ...text)
  }
  return chars.join("")
}

// Independent return fixture using the T and U positions in Santander H7815, revision 8.5.
export function bankReturn(
  remittance: string,
  sequence: number,
  occurrences: { index: number; code: string; fee?: number }[],
) {
  const rows = remittance.trimEnd().split(/\r?\n/)
  const ps = rows.filter((s) => s[13] === "P"),
    qs = rows.filter((s) => s[13] === "Q")
  const identity = testAgreement.agency + testAgreement.agencyDigit + testAgreement.account + testAgreement.accountDigit
  const registration = "2" + testAgreement.taxId.padStart(15, "0")
  const date = rows[0]!.slice(143, 151)
  const header = record([
    [1, "03300000"],
    [17, registration],
    [33, identity],
    [53, testAgreement.beneficiaryCode],
    [73, testAgreement.name],
    [103, "BANCO SANTANDER"],
    [143, "2" + date],
    [158, pad(sequence, 6) + "040"],
  ])
  const batch = record([
    [1, "03300011T01"],
    [14, "040"],
    [18, registration],
    [34, testAgreement.beneficiaryCode],
    [54, identity],
    [74, testAgreement.name],
    [184, pad(sequence, 8) + date],
  ])
  const details = occurrences.flatMap(({ index, code, fee = 0 }, i) => {
    const p = ps[index]!,
      q = qs[index]!
    const nominal = p.slice(85, 100)
    const paid = code === "06" ? Number(nominal) : 0
    const t = record([
      [1, "03300013" + pad(2 * i + 1, 5) + "T " + code],
      [18, identity],
      [41, p.slice(44, 57) + "2" + p.slice(62, 77)],
      [70, p.slice(77, 85) + nominal],
      [93, "03300000"],
      [101, p.slice(195, 220)],
      [126, "00" + q.slice(17, 73)],
      [194, pad(fee, 15)],
      [209, code === "03" ? "0300000000" : "0000000000"],
    ])
    const u = record([
      [1, "03300013" + pad(2 * i + 2, 5) + "U " + code],
      [18, "0".repeat(60)],
      [78, pad(paid, 15) + pad(paid - fee, 15) + "0".repeat(30)],
      [138, date + (paid ? date : "00000000")],
      [154, "0".repeat(27)],
      [211, "000"],
    ])
    return [t, u]
  })
  const nominal = occurrences.reduce((total, event) => total + Number(ps[event.index]!.slice(85, 100)), 0)
  const trailer = record([
    [1, "03300015"],
    [18, pad(details.length + 2, 6)],
    [24, pad(occurrences.length, 6)],
    [30, pad(nominal, 17)],
    [47, "0".repeat(69)],
  ])
  return (
    [
      header,
      batch,
      ...details,
      trailer,
      record([
        [1, "03399999"],
        [18, "000001" + pad(details.length + 4, 6)],
      ]),
    ].join("\r\n") + "\r\n"
  )
}
