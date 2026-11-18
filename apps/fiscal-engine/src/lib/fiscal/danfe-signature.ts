import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOMParser } from "@xmldom/xmldom";
import forge from "node-forge";
import { verifyNfeSignature } from "./nfce-qr.ts";

const namespace = "http://www.portalfiscal.inf.br/nfe";
const trustDirectory = process.env.DANFE_TRUST_DIR ?? fileURLToPath(new URL("../../../../../deploy/fiscal/", import.meta.url));
const normalizePem = (value: string) => value.replace(/\r\n/g, "\n").trim();

/** Only the shipped ICP roots are anchors. Intermediate CAs remain untrusted candidates. */
function verifyChain(leaf: string, roots: string, intermediates: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const process = execFile("openssl", [
      "verify", "-no-CApath", "-no-CAstore", "-CAfile", roots, "-untrusted", intermediates,
    ], { timeout: 5_000, maxBuffer: 16_384, windowsHide: true }, error => {
      if (!error) resolve(true);
      else if (error.code === 2) resolve(false);
      else reject(new Error("Validador ICP-Brasil indisponível"));
    });
    process.stdin?.on("error", () => {}); // The callback handles an early OpenSSL exit.
    process.stdin?.end(leaf);
  });
}

export async function verifyDanfeSignature(xml: unknown, suppliedRoots: unknown, directory = trustDirectory): Promise<boolean> {
  if (typeof xml !== "string" || Buffer.byteLength(xml) > 1_048_576 || /\0|<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) return false;
  let leaf: string;
  try {
    const root = new DOMParser({ onError: () => { throw new Error("XML inválido"); } })
      .parseFromString(xml, "application/xml").documentElement;
    if (!root || root.namespaceURI !== namespace || root.localName !== "nfeProc" || root.getAttribute("versao") !== "4.00") return false;
    const invoices = root.getElementsByTagNameNS(namespace, "NFe");
    const infos = root.getElementsByTagNameNS(namespace, "infNFe");
    const nfe = invoices.item(0), info = infos.item(0);
    if (!nfe || invoices.length !== 1 || nfe.parentNode !== root ||
        !info || infos.length !== 1 || info.parentNode !== nfe || !/^NFe\d{44}$/.test(info.getAttribute("Id") ?? "")) return false;
    const { certificate } = verifyNfeSignature(nfe, info, xml);
    if (certificate.ca) return false;
    leaf = certificate.toString();
    const usage = forge.pki.certificateFromPem(leaf).getExtension("keyUsage");
    if (!usage || !(usage.digitalSignature || usage.nonRepudiation)) return false;
  } catch {
    return false;
  }

  const roots = join(directory, "icp-brasil-roots.pem");
  // Refuse a mismatched caller bundle. A request cannot add anchors or widen trust.
  if (suppliedRoots != null && (typeof suppliedRoots !== "string" ||
      normalizePem(suppliedRoots) !== normalizePem(await readFile(roots, "utf8")))) return false;
  return verifyChain(leaf, roots, join(directory, "icp-brasil-intermediates.pem"));
}
