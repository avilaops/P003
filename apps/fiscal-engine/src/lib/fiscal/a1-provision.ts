import {createPrivateKey,X509Certificate} from "node:crypto";
import {mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import forge from "node-forge";
import {verifyChain} from "./danfe-signature.ts";
import {signingKeyOf} from "./sign.ts";

const directory=fileURLToPath(new URL("../../../../../deploy/fiscal/",import.meta.url));
const invalid=()=>new Error("Identidade A1 inválida");
export async function verifyA1(input:Record<string,unknown>) {
  if(typeof input.issuerTaxId!=="string" || !/^\d{14}$/.test(input.issuerTaxId) || !input.certificate || typeof input.certificate!=="object")throw invalid();
  const {pkcs12Base64,password}=input.certificate as Record<string,unknown>;
  if(typeof pkcs12Base64!=="string" || pkcs12Base64.length>87384 || typeof password!=="string" || Buffer.byteLength(password)>1024 || password.includes("\0"))throw invalid();
  const bytes=Buffer.from(pkcs12Base64,"base64");
  try {
    if(bytes.length>65536 || bytes.toString("base64")!==pkcs12Base64)throw invalid();
    const store=forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(bytes.toString("binary")),password);
    const keys=[forge.pki.oids.pkcs8ShroudedKeyBag,forge.pki.oids.keyBag].flatMap(type=>store.getBags({bagType:type})[type]??[]);
    if(keys.length!==1)throw invalid();
    const key=signingKeyOf(bytes,password),leaf=new X509Certificate(Buffer.from(key.certificateBase64,"base64")),cert=forge.pki.certificateFromPem(leaf.toString());
    const extension=(id:string)=>cert.extensions.find(e=>e.id===id);
    const asn=(v:forge.asn1.Asn1):forge.asn1.Asn1[]=>Array.isArray(v.value)?v.value:[];
    const oid=(v?:forge.asn1.Asn1)=>v?.tagClass===forge.asn1.Class.UNIVERSAL && v.type===forge.asn1.Type.OID && typeof v.value==="string"?forge.asn1.derToOid(v.value):"";
    const san=extension("2.5.29.17"),policies=extension("2.5.29.32");
    if(!san || !policies)throw invalid();
    const names=asn(forge.asn1.fromDer(san.value)).filter(n=>n.tagClass===forge.asn1.Class.CONTEXT_SPECIFIC && n.type===0 && oid(asn(n)[0])==="2.16.76.1.3.3");
    const raw=names.length===1?asn(names[0])[1]:undefined,doc=raw && raw.tagClass===forge.asn1.Class.CONTEXT_SPECIFIC && raw.type===0?asn(raw):[];
    if(doc.length!==1 || doc[0].value!==input.issuerTaxId || !asn(forge.asn1.fromDer(policies.value)).some(p=>/^2\.16\.76\.1\.2\.1(?:\.|$)/.test(oid(asn(p)[0]))))throw invalid();
    const bits=leaf.publicKey.asymmetricKeyDetails?.modulusLength??0,usage=cert.getExtension("keyUsage");
    const validatedAt=Math.floor(Date.now()/1000),validFrom=Math.floor(Date.parse(leaf.validFrom)/1000),validUntil=Math.floor(Date.parse(leaf.validTo)/1000);
    if(leaf.ca || !usage?.digitalSignature || leaf.publicKey.asymmetricKeyType!=="rsa" || bits<2048 || bits>8192 || !leaf.checkPrivateKey(createPrivateKey(key.privateKeyPem)) || validatedAt<validFrom || validatedAt>=validUntil)throw invalid();
    const roots=process.env.FISCAL_A1_CA_BUNDLE_FILE || join(directory,"icp-brasil-roots.pem");
    const intermediates=join(directory,"icp-brasil-intermediates.pem");
    const tmp=await mkdtemp(join(tmpdir(),"erp-ca-"));
    try{
      const candidates=join(tmp,"intermediates.pem");
      const extra=(key.certificateChainBase64??[]).map(data=>new X509Certificate(Buffer.from(data,"base64")).toString()).join("\n");
      await writeFile(candidates,(await readFile(intermediates,"utf8"))+"\n"+extra,{mode:0o600});
      if(!await verifyChain(leaf.toString(),roots,candidates,"sslclient"))throw invalid();
    }finally{await rm(tmp,{recursive:true,force:true})}
    return {subject:leaf.subject,issuer:leaf.issuer,taxId:input.issuerTaxId,fingerprint:leaf.fingerprint256.replaceAll(":","").toLowerCase(),serialNumber:leaf.serialNumber,validFrom,validUntil,validatedAt,chainVerified:true,revocationChecked:false};
  }finally{bytes.fill(0)}
}
