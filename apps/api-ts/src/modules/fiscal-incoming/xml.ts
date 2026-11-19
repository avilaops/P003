import { DOMParser, type Element } from "@xmldom/xmldom"
import { Problem } from "../../platform/problem.js"

export const ns="http://www.portalfiscal.inf.br/nfe"
const ds="http://www.w3.org/2000/09/xmldsig#"
export function invalid(title:string):never {throw new Problem(422,"invalid_fiscal_document",title)}
export function parseXml(xml:string) {
  if(!xml.length || Buffer.byteLength(xml)>921600 || /<!DOCTYPE|<!ENTITY/i.test(xml)) invalid("XML fiscal inválido ou acima de 900 KiB")
  try {
    const doc=new DOMParser({onError:()=>{throw Error("invalid")}}).parseFromString(xml,"application/xml")
    if(!doc.documentElement) invalid("Estrutura de XML fiscal inválida")
    const nodes=[doc.documentElement as import("@xmldom/xmldom").Node]
    let count=0
    while(nodes.length){
      const node=nodes.pop()!
      if(++count>100000) invalid("XML fiscal excede 100 mil nós")
      const nested=Array.from(node.childNodes??[])
      if(node.nodeType===1 && nested.some(n=>n.nodeType===7 || n.nodeType===8) && !nested.some(n=>n.nodeType===1)) invalid("Campo fiscal com comentário ou instrução ambígua")
      for(const entry of nested) nodes.push(entry)
    }
    return doc.documentElement
  } catch {return invalid("XML fiscal malformado")}
}
export const children=(node:Element,name:string,namespace=ns)=>Array.from(node.childNodes).filter((n):n is Element=>n.nodeType===1 && (n as Element).localName===name && (n as Element).namespaceURI===namespace)
export function child(node:Element,name:string,namespace=ns) {
  const found=children(node,name,namespace)
  return found.length===1?found[0]!:invalid("Campo fiscal ausente ou duplicado • "+name)
}
export function scalar(node:Element) {
  const nodes=Array.from(node.childNodes)
  return nodes.length===1 && nodes[0]?.nodeType===3 && nodes[0].nodeValue?.trim()?nodes[0].nodeValue.trim():invalid("Campo fiscal vazio ou ambíguo • "+node.localName)
}
export const value=(node:Element,name:string,namespace=ns)=>scalar(child(node,name,namespace))
export const key55=(key:string)=>key.slice(20,22)==="55" && validInvoiceKey(key)
function validInvoiceKey(key:string) {
  if(!/^\d{44}$/.test(key) || !["55","65"].includes(key.slice(20,22))) return false
  const sum=[...key.slice(0,43)].reverse().reduce((sum,d,i)=>sum+Number(d)*(2+i%8),0)
  const digit=11-sum%11
  return Number(key[43])===(digit>=10?0:digit)
}
function integer(s:string) {return /^\d+$/.test(s) && Number.isSafeInteger(Number(s))?Number(s):invalid("Número fiscal inválido")}
export function fiscalDecimal(s:string,scale:number) {
  if(!/^\d{1,18}(?:\.\d{1,20})?$/.test(s)) invalid("Decimal fiscal inválido")
  const [whole,frac=""]=s.split(".")
  if(/[1-9]/.test(frac.slice(scale))) invalid("Precisão fiscal incompatível")
  const v=BigInt(whole!+frac.slice(0,scale).padEnd(scale,"0"))
  return v<=9223372036854775807n?v:invalid("Valor fiscal fora do limite")
}
export function inspectInvoice(xml:string,recipient:string|null) {
  const root=parseXml(xml)
  if(root.namespaceURI!==ns || root.localName!=="nfeProc" || root.getAttribute("versao")!=="4.00" || Array.from(root.childNodes).filter(n=>n.nodeType===1).length!==2) invalid("Envie o XML autorizado nfeProc 4.00 com protocolo")
  const nfe=child(root,"NFe"),info=child(nfe,"infNFe"),prot=child(root,"protNFe"),p=child(prot,"infProt")
  const id=info.getAttribute("Id")??"",key=id.slice(3)
  if(!id.startsWith("NFe") || !validInvoiceKey(key) || info.getAttribute("versao")!=="4.00" || prot.getAttribute("versao")!=="4.00") invalid("Chave, modelo ou versão da NF-e inválida")
  const ide=child(info,"ide"), env=value(ide,"tpAmb"),emit=child(info,"emit"),dest=child(info,"dest")
  const ids=[...children(dest,"CNPJ"),...children(dest,"CPF")]
  if(ids.length>1) invalid("Destinatário com documentos conflitantes")
  const destDoc=ids.length?scalar(ids[0]!):null
  if(destDoc && !(ids[0]!.localName==="CNPJ"?/^\d{14}$/:/^\d{11}$/).test(destDoc)) invalid("Documento do destinatário inválido")
  if(recipient!==null && destDoc!==recipient) throw new Problem(403,"document_company_mismatch","A empresa ativa deve ser destinatária desta NF-e")
  const issuer=children(emit,"CNPJ").length?value(emit,"CNPJ"):value(emit,"CPF")
  if(children(emit,"CNPJ").length+children(emit,"CPF").length!==1 || !(children(emit,"CNPJ").length?/^\d{14}$/:/^\d{11}$/).test(issuer) || key.slice(6,20)!==issuer.padStart(14,"0")) invalid("Emitente incompatível com a chave")
  const number=integer(value(ide,"nNF")),series=integer(value(ide,"serie")),issuedAt=value(ide,"dhEmi")
  if(!number || number!==Number(key.slice(25,34)) || series!==Number(key.slice(22,25)) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(issuedAt) || !Number.isFinite(Date.parse(issuedAt)) || key.slice(2,6)!==issuedAt.slice(2,4)+issuedAt.slice(5,7)) invalid("Número, série ou emissão incompatível com a chave")
  if(value(ide,"mod")!==key.slice(20,22) || !["1","2"].includes(env) || value(p,"tpAmb")!==env || value(p,"chNFe")!==key || !["100","150"].includes(value(p,"cStat")) || !/^\d{15}$/.test(value(p,"nProt"))) invalid("Protocolo de autorização incompatível com a NF-e")
  value(p,"dhRecbto")
  const ref=child(child(child(nfe,"Signature",ds),"SignedInfo",ds),"Reference",ds),digest=value(ref,"DigestValue",ds).replace(/\s/g,"")
  const bytes=Buffer.from(digest,"base64")
  if(ref.getAttribute("URI")!=="#"+id || value(p,"digVal").replace(/\s/g,"")!==digest || bytes.toString("base64")!==digest || ![20,32].includes(bytes.length)) invalid("Protocolo e referência da assinatura incompatíveis")
  const items=children(info,"det")
  const numbers=items.map(n=>integer(n.getAttribute("nItem")??"")).sort((a,b)=>a-b)
  if(!items.length || items.length>990 || numbers.some((n,i)=>n!==i+1)) invalid("Numeração de itens fiscais ausente ou duplicada")
  const total=fiscalDecimal(value(child(child(info,"total"),"ICMSTot"),"vNF"),2)
  const name=value(emit,"xNome")
  if([...name].length>200 || total>99999999999999n || new Date(issuedAt.slice(0,10)+"T00:00:00Z").toISOString().slice(0,10)!==issuedAt.slice(0,10)) invalid("Nome, valor total ou data de emissão inválidos")
  return {key,issuer,name,recipient:destDoc,number,series,issuedAt,total,environment:Number(env),items}
}
export function purchaseItems(xml:string,recipient:string) {
  const invoice=inspectInvoice(xml,recipient)
  const items=invoice.items.map(node=>{
    const p=child(node,"prod"),qty=fiscalDecimal(value(p,"qCom"),6),unit=fiscalDecimal(value(p,"vUnCom"),2),merch=fiscalDecimal(value(p,"vProd"),2)
    if(qty<=0n || (qty*unit+500000n)/1000000n!==merch || children(p,"indTot").some(n=>scalar(n)!=="1")) invalid("Quantidade, custo ou inclusão no total divergentes")
    let landed=merch
    const components:Record<string,bigint>={}
    for(const field of ["vFrete","vSeg","vOutro","vDesc","vIPI","vIPIDevol","vICMSST","vFCPST","vII","vICMS","vPIS","vCOFINS"]) {
      const nodes=Array.from(node.getElementsByTagNameNS(ns,field))
      if(nodes.length>1) invalid("Componente de custo repetido • "+field)
      const amount=nodes.length?fiscalDecimal(scalar(nodes[0]!),2):0n
      components[field]=amount
      if(!["vICMS","vPIS","vCOFINS"].includes(field)) landed+=field==="vDesc"?-amount:amount
    }
    const landedUnit=(landed*1000000n+qty/2n)/qty
    if(landed<0n || (qty*landedUnit+500000n)/1000000n!==landed) invalid("Custo posto não representável em centavos por unidade")
    return {number:integer(node.getAttribute("nItem")!),sourceCode:value(p,"cProd"),name:value(p,"xProd"),ncm:value(p,"NCM"),unit:value(p,"uCom"),quantityMicros:qty,unitCostCents:landedUnit,merchandiseCents:merch,landedCents:landed,components}
  })
  if(items.reduce((sum,i)=>sum+i.landedCents,0n)!==invoice.total) invalid("Soma dos itens diverge do total fiscal")
  return items
}
