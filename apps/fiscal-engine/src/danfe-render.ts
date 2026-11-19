import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import { DOMParser, type Element } from "@xmldom/xmldom";
import { fiscalMcpEndpoint, rpcResponse } from "./danfe-mcp.ts";
import { verifyDanfeSignature } from "./lib/fiscal/danfe-signature.ts";
import {renderNfceReceipt} from "./lib/fiscal/nfce-receipt.ts";
import { accessKeyDigit } from "./lib/fiscal/nfe.ts";

const namespace = "http://www.portalfiscal.inf.br/nfe";
type Data = Record<string, unknown>;
const object = (v: unknown): v is Data => !!v && typeof v === "object" && !Array.isArray(v);
const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const invalid = () => new Error("Documento fiscal incompatível");

function direct(parent: Element, name: string, ns = namespace) {
  const elements = Array.from(parent.childNodes).filter((n): n is Element => n.nodeType === 1 &&
    (n as Element).namespaceURI === ns && (n as Element).localName === name);
  if (elements.length !== 1) throw invalid();
  return elements[0];
}

/** Runs after the official nfeProc XSD. Bind the authorized protocol to the same signed invoice. */
function layout(xml: string, key: string, issuer: string, ambient: string) {
  const root = new DOMParser({ onError: () => { throw invalid(); } }).parseFromString(xml, "application/xml").documentElement;
  if (!root || root.namespaceURI !== namespace || root.localName !== "nfeProc" || root.getAttribute("versao") !== "4.00") throw invalid();
  const nfe = direct(root, "NFe"), info = direct(nfe, "infNFe"), ide = direct(info, "ide");
  const protocol = direct(direct(root, "protNFe"), "infProt");
  const ds = "http://www.w3.org/2000/09/xmldsig#";
  const reference = direct(direct(direct(nfe, "Signature", ds), "SignedInfo", ds), "Reference", ds);
  if (info.getAttribute("Id") !== "NFe" + key || direct(ide, "mod").textContent !== key.slice(20,22) ||
      direct(direct(info, "emit"), issuer.length === 11 ? "CPF" : "CNPJ").textContent !== issuer ||
      key.slice(6,20) !== issuer.padStart(14,"0") || !["55","65"].includes(key.slice(20,22)) ||
      accessKeyDigit(key.slice(0,43)) !== key[43] || direct(ide, "tpAmb").textContent !== ambient ||
      direct(protocol, "tpAmb").textContent !== ambient || direct(protocol, "chNFe").textContent !== key ||
      !["100","150"].includes(direct(protocol, "cStat").textContent ?? "") || !/^\d{15}$/.test(direct(protocol, "nProt").textContent ?? "") ||
      direct(protocol, "digVal").textContent?.replace(/\s/g,"") !== direct(reference, "DigestValue", ds).textContent?.replace(/\s/g,"")) throw invalid();
  return direct(ide, "tpImp").textContent === "6" ? "gerar_danfe_simplificado_tipo2" : "gerar_danfe";
}

export async function renderAuthorizedDanfe(input: unknown, response: ServerResponse, token: string, endpoint = fiscalMcpEndpoint) {
  if (!object(input) || typeof input.xml !== "string" || Buffer.byteLength(input.xml) > 900 * 1024 ||
      /\0|<!\s*(?:DOCTYPE|ENTITY)\b/i.test(input.xml) || typeof input.accessKey !== "string" || !/^\d{44}$/.test(input.accessKey) ||
      typeof input.issuerTaxId !== "string" || !/^(?:\d{11}|\d{14})$/.test(input.issuerTaxId) ||
      (input.environment !== "homologation" && input.environment !== "production")) throw invalid();
  const { xml, accessKey, issuerTaxId } = input;
  const ambient = input.environment === "homologation" ? "2" : "1";
  const headers = new Headers({ authorization: "Bearer " + token, "content-type": "application/json",
    accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" });
  const signal = AbortSignal.timeout(45_000);
  async function rpc(method: string, params?: Data, id?: number, maximum?: number) {
    const result = await fetch(endpoint, { method: "POST", headers, signal, redirect: "error",
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    if (!result.ok) { await result.body?.cancel(); throw invalid(); }
    if (id === undefined) { await result.body?.cancel(); return {}; }
    if (method === "initialize") {
      const session = result.headers.get("mcp-session-id");
      if (session) headers.set("mcp-session-id", session);
    }
    const message = await rpcResponse(result,id,maximum);
    if (!object(message.result) || message.error || message.result.isError === true) throw invalid();
    return message.result;
  }
  async function tool(id: number, name: string, args: Data, maximum?: number): Promise<Data> {
    const result = await rpc("tools/call", { name, arguments: args }, id, maximum);
    if (object(result.structuredContent)) return result.structuredContent;
    if (!Array.isArray(result.content) || result.content.length !== 1 || result.content[0]?.type !== "text") throw invalid();
    const data: unknown = JSON.parse(result.content[0].text);
    if (!object(data)) throw invalid();
    return data;
  }
  try {
    const init = await rpc("initialize",{ protocolVersion:"2025-06-18", capabilities:{}, clientInfo:{ name:"fiscal-engine-danfe", version:"1" } },1);
    if (typeof init.protocolVersion !== "string" || !["2025-03-26","2025-06-18","2025-11-25"].includes(init.protocolVersion)) throw invalid();
    headers.set("mcp-protocol-version",init.protocolVersion);
    await rpc("notifications/initialized");
    const schema = await tool(2,"validar_xml_fiscal",{ xml_content:xml, tipo:"nfe" });
    if (schema.valido !== true || schema.documento !== "nfeProc" || schema.modelo !== accessKey.slice(20,22) || schema.tipo !== "nfe" || schema.chave_acesso !== accessKey) throw invalid();
    const renderer = layout(xml,accessKey,issuerTaxId,ambient);
    if (!await verifyDanfeSignature(xml,null)) throw invalid();
    if(accessKey.slice(20,22)==="65"){
      const pdf=await renderNfceReceipt(xml,accessKey);
      if(pdf.length>8*1024*1024)throw invalid();
      response.writeHead(200,{"content-type":"application/pdf","cache-control":"no-store","x-nfe-environment":ambient,
        "content-disposition":'attachment; filename="DANFE-'+accessKey+'.pdf"',"x-xml-sha256":hash(xml),"x-pdf-sha256":hash(pdf)});
      response.end(pdf);
      return;
    }
    const document = await tool(3,renderer,{ xml_content:xml },24 * 1024 * 1024);
    if (document.chave_acesso !== accessKey || document.modelo !== 55 || typeof document.pdf_base64 !== "string" ||
        document.pdf_base64.length > Math.ceil(8 * 1024 * 1024 / 3) * 4) throw invalid();
    const pdf = Buffer.from(document.pdf_base64,"base64");
    if (pdf.length < 100 || pdf.length > 8 * 1024 * 1024 || pdf.toString("base64") !== document.pdf_base64 ||
        pdf.subarray(0,5).toString() !== "%PDF-" || !pdf.subarray(-1024).includes("%%EOF")) throw invalid();
    response.writeHead(200,{ "content-type":"application/pdf", "cache-control":"no-store", "x-nfe-environment":ambient,
      "content-disposition":'attachment; filename="DANFE-' + accessKey + '.pdf"', "x-xml-sha256":hash(xml), "x-pdf-sha256":hash(pdf) });
    response.end(pdf);
  } finally {
    if (headers.has("mcp-session-id")) {
      const closed = await fetch(endpoint,{ method:"DELETE", headers, redirect:"error", signal:AbortSignal.timeout(2_000) }).catch(() => null);
      await closed?.body?.cancel().catch(() => {});
    }
  }
}
