import type { AuthorizedContext } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import type { CertificateMaterial } from "../outgoing-nfse/engine-client.js"

export type FiscalOperation="offline-receipt"|"verify-a1"|"prepare"|"authorize"|"consult"|"event"|"void"|"distribute"|"manifest"
export type FiscalOperations = {
  call(operation:FiscalOperation,input:Record<string,unknown>):Promise<Record<string,unknown>>
  material(c:AuthorizedContext):Promise<{issuerTaxId:string;certificate:CertificateMaterial}>
  production(tenant:string):boolean
  productionRecipient?(tenant:string):boolean
  nfceSecret(c:AuthorizedContext,environment:string):Promise<Record<string,unknown>>
}

export function fiscalTransport(origin:string,token:string,fetcher=fetch):FiscalOperations["call"] {
  const base=new URL(origin)
  if (base.protocol!=="http:" || !["127.0.0.1","localhost","[::1]"].includes(base.hostname) || base.username || base.password || base.pathname!=="/" || base.search || base.hash || token.length<24) throw Error("Configuração do motor fiscal privado inválida")
  return async(operation,input)=>{
    const unavailable=()=>new Problem(503,"fiscal_operation_uncertain","O motor fiscal não confirmou a operação. Consulte a situação do documento")
    try {
      const response=await fetcher(new URL("/v1/"+operation,base),{method:"POST",redirect:"error",signal:AbortSignal.timeout(55_000),
        headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify(input)})
      if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("application/json")) {await response.body?.cancel();throw unavailable()}
      const reader=response.body.getReader(), chunks:Buffer[]=[]
      let size=0
      for (;;) {
        const {done,value}=await reader.read()
        if (done) break
        size+=value.byteLength
        if(size>6*1024*1024){await reader.cancel();throw unavailable()}
        chunks.push(Buffer.from(value))
      }
      const json:unknown=JSON.parse(Buffer.concat(chunks).toString("utf8"))
      if (!json || typeof json!=="object" || Array.isArray(json)) throw unavailable()
      return json as Record<string,unknown>
    } catch {throw unavailable()}
  }
}
