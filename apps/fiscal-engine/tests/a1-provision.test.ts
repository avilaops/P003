import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import forge from "node-forge";
import {verifyA1} from "../src/lib/fiscal/a1-provision.ts";
import {serverIdentity} from "./fiscal-helpers.ts";

test("A1 • identidade da empresa, política, par de chaves e cadeia até a raiz configurada",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"erp-trust-fixture-")),prior=process.env.FISCAL_A1_CA_BUNDLE_FILE;
  try{
    const ca=serverIdentity(),root=forge.pki.certificateFromPem(ca.cert),pair=forge.pki.rsa.generateKeyPair(2048);
    const leaf=forge.pki.createCertificate(),taxId="04252011000110",a=forge.asn1;
    leaf.publicKey=pair.publicKey;leaf.serialNumber="41";leaf.setSubject([{name:"commonName",value:"Fixture"}]);leaf.setIssuer(root.subject.attributes);
    leaf.validity.notBefore=new Date(Date.now()-600000);leaf.validity.notAfter=new Date(Date.now()+86400000);
    const seq=(v:forge.asn1.Asn1[])=>a.create(a.Class.UNIVERSAL,a.Type.SEQUENCE,true,v);
    const oid=(v:string)=>a.create(a.Class.UNIVERSAL,a.Type.OID,false,a.oidToDer(v).getBytes());
    const tagged=(v:forge.asn1.Asn1[])=>a.create(a.Class.CONTEXT_SPECIFIC,0,true,v);
    const san=seq([tagged([oid("2.16.76.1.3.3"),tagged([a.create(a.Class.UNIVERSAL,a.Type.OCTETSTRING,false,taxId)])])]);
    leaf.setExtensions([{name:"basicConstraints",cA:false},{name:"keyUsage",digitalSignature:true},{name:"extKeyUsage",clientAuth:true},
      {id:"2.5.29.17",value:a.toDer(san).getBytes()},{id:"2.5.29.32",value:a.toDer(seq([seq([oid("2.16.76.1.2.1.99")])])).getBytes()}]);
    leaf.sign(forge.pki.privateKeyFromPem(ca.key),forge.md.sha256.create());
    const pack=forge.pkcs12.toPkcs12Asn1(pair.privateKey,[leaf,root],"sample",{algorithm:"3des"});
    const input={issuerTaxId:taxId,certificate:{pkcs12Base64:Buffer.from(a.toDer(pack).getBytes(),"binary").toString("base64"),password:"sample"}};
    const fixture=join(dir,"ca.pem");await writeFile(fixture,ca.cert);process.env.FISCAL_A1_CA_BUNDLE_FILE=fixture;
    const proof=await verifyA1(input);assert.equal(proof.taxId,taxId);assert.equal(proof.chainVerified,true);assert.equal(proof.revocationChecked,false);
    await assert.rejects(verifyA1({...input,issuerTaxId:"19131243000197"}));
    await writeFile(fixture,serverIdentity().cert);await assert.rejects(verifyA1(input));
  }finally{if(prior===undefined)delete process.env.FISCAL_A1_CA_BUNDLE_FILE;else process.env.FISCAL_A1_CA_BUNDLE_FILE=prior;await rm(dir,{recursive:true,force:true})}
});
