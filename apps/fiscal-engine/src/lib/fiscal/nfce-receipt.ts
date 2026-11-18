import {assertFiscalXml} from "./local-layout.ts";
import {verifyNfeSignature} from "./nfce-qr.ts";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { DOMParser,type Element } from "@xmldom/xmldom";
import {nfceSp} from "./nfce-sp.ts";

const ns="http://www.portalfiscal.inf.br/nfe";
const nodes=(parent:Element,name:string)=>Array.from(parent.childNodes).filter((node):node is Element=>node.nodeType===1 && (node as Element).namespaceURI===ns && (node as Element).localName===name);
const part=(parent:Element,name:string)=>nodes(parent,name)[0];
const field=(parent:Element|undefined,name:string)=>parent?part(parent,name)?.textContent?.trim()??"":"";
const address=(a:Element|undefined)=>["xLgr","nro","xCpl","xBairro","xMun","UF","CEP"].map(k=>field(a,k)).filter(Boolean).join(", ");
const decimal=(v:string,minimum=2)=>{if(!/^\d+(\.\d+)?$/.test(v))throw Error("Valor de NFC-e inválido");const [n,f=""]=v.split(".");const suffix=f.replace(/0+$/,"").padEnd(minimum,"0");return BigInt(n).toLocaleString("pt-BR")+(suffix?","+suffix:"")};
const date=(s:string)=>s.slice(8,10)+"/"+s.slice(5,7)+"/"+s.slice(0,4)+" "+s.slice(11,19);
const methods:Record<string,string>={"01":"Dinheiro","02":"Cheque","03":"Cartão de crédito","04":"Cartão de débito","05":"Crédito da loja","10":"Vale alimentação","11":"Vale refeição","12":"Vale presente","13":"Vale combustível","14":"Duplicata","15":"Boleto","16":"Depósito","17":"Pix dinâmico","18":"Transferência","19":"Crédito virtual","20":"Pix estático","21":"Crédito em loja","22":"Falha de hardware","90":"Sem pagamento","99":"Outros"};

export async function renderNfceReceipt(xml:string,accessKey:string,offlineEnvironment?:"production"|"homologation") {
  const doc=new DOMParser({onError:()=>{throw Error("XML inválido")}}).parseFromString(xml,"application/xml"),root=doc.documentElement!;
  const nfe=offlineEnvironment?root:part(root,"NFe")!,info=part(nfe,"infNFe")!,ide=part(info,"ide")!,emitter=part(info,"emit")!,supplement=part(nfe,"infNFeSupl")!;
  const environment=field(ide,"tpAmb"),protocolNode=part(root,"protNFe"),protocol=protocolNode?part(protocolNode,"infProt"):undefined,key=offlineEnvironment?(info.getAttribute("Id")||"").slice(3):field(protocol,"chNFe"),urls=nfceSp(environment==="1"?"producao":"homologacao");
  if(!supplement || key!==accessKey || key.slice(0,2)!=="35" || key.slice(20,22)!=="65" || field(ide,"mod")!=="65" || !["1","2"].includes(environment))throw Error("Comprovante NFC-e incompatível");
  if(offlineEnvironment){
    if(root.namespaceURI!==ns || root.localName!=="NFe" || info.getAttribute("Id")!=="NFe"+accessKey || key[34]!=="9" ||
      field(ide,"tpEmis")!=="9" || field(emitter,"CNPJ")!==key.slice(6,20) || environment!==(offlineEnvironment==="production"?"1":"2"))throw Error("XML incompatível com a contingência offline");
    await assertFiscalXml(xml,"nfe");
    verifyNfeSignature(nfe,info,xml);
  }
  const qrLink=field(supplement,"qrCode"),url=new URL(qrLink),lookup=field(supplement,"urlChave"),lookupUrl=new URL(lookup),allowedHost=new URL(urls.qrCodeUrl).host;
  if([url,lookupUrl].some(u=>u.protocol!=="https:" || u.host!==allowedHost || u.username || u.password || u.hash) ||
    !["/qrcode","/nfceconsultapublica/paginas/consultaqrcode.aspx"].includes(url.pathname.toLowerCase()) || !["/nfceconsultapublica","/consulta"].includes(lookupUrl.pathname.toLowerCase().replace(/\/$/,"")) || lookupUrl.search ||
    !new RegExp("^\\?p="+key+"\\|[23]\\|"+environment+"(?:\\||$)").test(url.search) || url.search.includes("&"))throw Error("QR Code divergente da chave, ambiente ou UF");
  const qr=await QRCode.toBuffer(qrLink,{type:"png",errorCorrectionLevel:"M",margin:4,width:340});
  const pdf=new PDFDocument({size:[226.77,650],margins:{top:9,right:9,bottom:10,left:9},info:{Title:"DANFE NFC-e "+field(ide,"nNF")}}),chunks:Buffer[]=[];
  const result=new Promise<Buffer>((resolve,reject)=>{pdf.on("data",v=>chunks.push(v));pdf.on("error",reject);pdf.on("end",()=>resolve(Buffer.concat(chunks)))});
  const line=(s:string,bold=false,center=false)=>pdf.font(bold?"Helvetica-Bold":"Helvetica").fontSize(bold?9:8).text(s,9,pdf.y,{width:208,align:center?"center":"left",lineGap:1});
  line(field(emitter,"xNome"),true,true);line("CNPJ "+field(emitter,"CNPJ")+" • IE "+field(emitter,"IE"),false,true);line(address(part(emitter,"enderEmit")),false,true);
  line("DANFE NFC-e",true,true);line("Documento Auxiliar da Nota Fiscal de Consumidor Eletrônica",false,true);
  if(environment==="2")line("EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO • SEM VALOR FISCAL",true,true);
  if(field(ide,"tpEmis")==="9")line("EMITIDA EM CONTINGÊNCIA",true,true);
  pdf.moveDown(0.5);
  const items=nodes(info,"det");
  for(const det of items){
    const p=part(det,"prod")!;
    line(field(p,"cProd")+" • "+field(p,"xProd"),true);line(decimal(field(p,"qCom"),0)+" "+field(p,"uCom")+" × R$ "+decimal(field(p,"vUnCom"))+" • R$ "+decimal(field(p,"vProd")));
  }
  const total=part(part(info,"total")!,"ICMSTot")!;
  line("Quantidade de itens • "+items.length);
  line("Total dos produtos • R$ "+decimal(field(total,"vProd")));
  for(const [tag,label] of [["vDesc","Desconto"],["vFrete","Frete"],["vSeg","Seguro"],["vOutro","Outras despesas"]]){
    const v=field(total,tag);if(v && Number(v)>0)line(label+" • R$ "+decimal(v));
  }
  line("Valor a pagar • R$ "+decimal(field(total,"vNF")),true);
  const payment=part(info,"pag");
  for(const detail of payment?nodes(payment,"detPag"):[]){const code=field(detail,"tPag");line((field(detail,"xPag")||methods[code]||"Pagamento "+code)+" • R$ "+decimal(field(detail,"vPag")))}
  if(field(payment,"vTroco"))line("Troco • R$ "+decimal(field(payment,"vTroco")));
  line("Consulte pela chave de acesso em",false,true);line(lookup,false,true);line(key.match(/.{4}/g)!.join(" "),false,true);
  if(pdf.y>520)pdf.addPage();
  pdf.image(qr,67,pdf.y,{width:93,height:93});pdf.y+=96;
  const buyer=part(info,"dest"),docId=field(buyer,"CPF")||field(buyer,"CNPJ")||field(buyer,"idEstrangeiro");
  line(docId?"Consumidor • "+docId+(field(buyer,"xNome")?" • "+field(buyer,"xNome"):""):"Consumidor não identificado",true,true);
  if(buyer && part(buyer,"enderDest"))line(address(part(buyer,"enderDest")),false,true);
  line("NFC-e "+field(ide,"nNF")+" • Série "+field(ide,"serie")+" • "+date(field(ide,"dhEmi")),false,true);
  if(offlineEnvironment)line("Pendente de autorização",true,true);
  else {line("Protocolo de autorização • "+field(protocol,"nProt"),false,true);line("Autorização • "+date(field(protocol,"dhRecbto")),false,true)}
  if(field(total,"vTotTrib"))line("Tributos aproximados • R$ "+decimal(field(total,"vTotTrib")));
  const extra=part(info,"infAdic");
  for(const label of ["infAdFisco","infCpl"]){const v=field(extra,label);if(v)line(v)}
  pdf.end();
  return result;
}
