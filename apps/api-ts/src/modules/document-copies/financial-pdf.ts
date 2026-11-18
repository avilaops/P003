import PDFDocument from "pdfkit"

export const brl = (cents: bigint) => {
  const abs = cents < 0n ? -cents : cents
  return `R$ ${cents < 0n ? "-" : ""}${(abs / 100n).toLocaleString("pt-BR")},${(abs % 100n).toString().padStart(2, "0")}`
}

export function financialPdf(title: string, company: string, write: (pdf: PDFKit.PDFDocument) => void) {
  const pdf = new PDFDocument({
    size: "A4", margins: { top: 52, left: 52, right: 52, bottom: 52 },
    info: { Title: title, Author: company }
  })
  const chunks: Buffer[] = []
  const result = new Promise<Buffer>((resolve, reject) => {
    pdf.on("data", chunk => chunks.push(chunk))
    pdf.on("end", () => resolve(Buffer.concat(chunks)))
    pdf.on("error", reject)
  })
  pdf.fillColor("#173247").font("Helvetica-Bold").fontSize(23).text(title)
  pdf.moveDown(0.5).fontSize(14).text(company)
  write(pdf)
  pdf.end()
  return result
}
