export type SigningFile = { id: string; filename: string; position: number; done: boolean; stageRevision: string; headRevision: string; parentSha256: string }

export const responseHeaders = {
  "cache-control": "private, no-store, max-age=0",
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "x-robots-tag": "noindex, nofollow",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
}
const html = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!)
const styles = `*{box-sizing:border-box}body{font:1rem/1.55 system-ui,sans-serif;color:#153330;background:#f4f7f5;margin:0}header,main{max-width:45rem;margin:auto;padding:1.4rem}header{font-weight:700;color:#146958}main{margin:2vh auto 8vh}h1{font-size:clamp(1.8rem,5vw,2.65rem);line-height:1.13;margin:0 0 1rem}h2{font-size:1.1rem;margin:0 0 .6rem}article{background:white;border:1px solid #b9cdc4;border-radius:.8rem;padding:1.2rem;margin:1rem 0;overflow-wrap:anywhere}button{font:inherit;font-weight:650;padding:.65rem 1rem;color:white;background:#12624f;border:0;border-radius:.45rem;cursor:pointer}a{color:#095d54;font-weight:600}label,input{display:block}input{font:inherit;max-width:100%;margin:.5rem 0 1rem}form{margin:1rem 0}a:focus-visible,button:focus-visible,input:focus-visible{outline:3px solid #2563eb;outline-offset:3px}`
function page(content: string, status = 200) {
  return new Response(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Assinatura com e-CPF • Ávila Ops</title><style>${styles}</style></head><body><header>Ávila Ops • Contratos</header><main>${content}</main></body></html>`,
    { status, headers: { ...responseHeaders, "content-type": "text/html; charset=utf-8" } })
}
export function entryPage(base: string, verifiedCookie: boolean, message?: string, status = 200) {
  return page(`<h1>Assinatura com e-CPF</h1>${message ? `<p role="status">${html(message)}</p>` : ""}${
    verifiedCookie ? `<p>Confirme seu acesso para consultar os documentos disponíveis para a sua assinatura.</p><form method="post" action="${base}/entrar"><button>Consultar meus documentos</button></form>`
    : "<p>Abra o convite original enviado ao seu e-mail neste navegador. Conclua a verificação por código no portal e volte a esta página.</p>"}`, status)
}
export function documentsPage(base: string, files: SigningFile[]) {
  return page(`<h1>Documentos para assinar</h1><p>Baixe a versão atual de cada PDF e assine com o seu e-CPF ICP-Brasil. No assinador, escolha uma assinatura incremental em um novo campo invisível, sem carimbo de tempo. Esse formato preserva as assinaturas anteriores e é aceito pelo validador desta etapa.</p>${
    files.map(f => `<article><h2>${f.position} • ${html(f.filename)}</h2>${f.done ? "<p>Assinatura validada neste documento.</p>" :
      `<a href="${base}/baixar/${f.id}">Baixar PDF para assinatura</a><form method="post" enctype="multipart/form-data" action="${base}/enviar/${f.id}">
      <input type="hidden" name="revision" value="${f.stageRevision}:${f.headRevision}:${f.parentSha256}"><label>PDF assinado • até 32 MiB<input required type="file" name="file" accept="application/pdf,.pdf"></label>
      <button>Enviar PDF para validação</button></form>`}</article>`).join("")}`)
}
export function messagePage(base: string, title: string, message: string, status: number, link = "Voltar aos documentos") {
  return page(`<h1>${html(title)}</h1><p role="status">${html(message)}</p><p><a href="${base}">${html(link)}</a></p>`, status)
}
