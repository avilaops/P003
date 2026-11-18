import { child,children,fiscalDecimal,inspectInvoice,invalid,key55,ns,parseXml,value } from "./xml.js"

export const events={ciencia:"210210",confirmacao:"210200",desconhecimento:"210220",nao_realizada:"210240"} as const
export type Evidence={code:string;eventType:string;protocol:string;sequence:string}
type Meta={issuerDocument?:string;issuerName?:string;issuedAt?:string;totalCents?:bigint;situation?:string;eventType?:string;number?:number;series?:number;recipientDocument?:string}
export function inspectDistributed(xml:string,kind:string,recipient:string,environment:number):{key:string;metadata:Meta;evidence?:Evidence} {
  if(kind==="full"){
    const n=inspectInvoice(xml,environment===1?null:recipient)
    if(n.environment!==environment)invalid("XML distribuído pertence a outro ambiente")
    return {key:n.key,metadata:{issuerDocument:n.issuer,issuerName:n.name,issuedAt:n.issuedAt,totalCents:n.total,number:n.number,series:n.series,...(n.recipient?{recipientDocument:n.recipient}:{}),situation:"1"}}
  }
  const root=parseXml(xml)
  if(root.namespaceURI!==ns)invalid("Namespace de distribuição inválido")
  if(kind==="summary" && root.localName==="resNFe"){
    const key=value(root,"chNFe"),issuerDocument=value(root,"CNPJ"),issuedAt=value(root,"dhEmi"),issuerName=value(root,"xNome")
    if(!key55(key) || issuerDocument!==key.slice(6,20) || !Number.isFinite(Date.parse(issuedAt)) || issuerName.length>200)invalid("Identidade do resumo da NF-e inválida")
    return {key,metadata:{issuerDocument,issuerName,issuedAt,totalCents:fiscalDecimal(value(root,"vNF"),2),...(children(root,"cSitNFe").length?{situation:value(root,"cSitNFe")}:{})}}
  }
  if(kind!=="event" || !["resEvento","procEventoNFe"].includes(root.localName??""))invalid("Tipo fiscal incompatível com o XML distribuído")
  if(root.localName==="resEvento"){
    const key=value(root,"chNFe"),eventType=value(root,"tpEvento")
    if(!key55(key)||!/^\d{6}$/.test(eventType))invalid("Evento resumido inválido")
    return {key,metadata:{eventType}}
  }
  const request=child(child(root,"evento"),"infEvento"),result=child(child(root,"retEvento"),"infEvento")
  const key=value(request,"chNFe"),eventType=value(request,"tpEvento"),sequence=value(request,"nSeqEvento")
  if(!key55(key)||!/^\d{6}$/.test(eventType)||value(result,"chNFe")!==key||value(result,"tpEvento")!==eventType || value(result,"nSeqEvento")!==sequence || value(request,"tpAmb")!==String(environment)||value(result,"tpAmb")!==String(environment)) invalid("Evento distribuído diverge da resposta ou do ambiente")
  const metadata={eventType},code=value(result,"cStat")
  if(!(Object.values(events) as string[]).concat("110111").includes(eventType) || !(code==="135" || environment===2&&eventType!=="110111"&&code==="136" || eventType==="110111"&&code==="155")) return {key,metadata}
  if(!["1","2"].includes(sequence)||["110111","210210"].includes(eventType)&&sequence!=="1" || request.getAttribute("Id")!=="ID"+eventType+key+sequence.padStart(2,"0")) invalid("Identificador e sequência do evento incompatíveis")
  if(children(request,"CPF").length+children(request,"CNPJ").length!==1) invalid("Autor do evento ambíguo")
  const author=value(request,children(request,"CNPJ").length?"CNPJ":"CPF")
  if(eventType==="110111" && author.padStart(14,"0")!==key.slice(6,20)) invalid("Cancelamento incompatível com o emitente")
  if(eventType!=="110111"&&author!==recipient || children(result,"CNPJDest").length && value(result,"CNPJDest")!==recipient) return {key,metadata}
  const protocol=value(result,"nProt")
  if(!/^\d{15}$/.test(protocol))invalid("Protocolo do evento inválido")
  return {key,metadata,evidence:{code,eventType,protocol,sequence}}
}
