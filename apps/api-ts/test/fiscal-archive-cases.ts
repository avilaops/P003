import assert from "node:assert/strict"
import type {FastifyInstance} from "fastify"
import type {Pool} from "pg"
import {checkDigit} from "../src/modules/fiscal-workspace/emission.js"
import {sha256} from "../src/modules/nfe-email/danfe.js"

export async function verifyFiscalArchive(app:FastifyInstance,db:Pool,company:string,role:string) {
  const headers={authorization:"Bearer reader","x-tenant-id":company},base="/api/v1/fiscal",path=base+"/outgoing-imports"
  const get=(url:string)=>app.inject({url,headers})
  const set=(url:string,payload:object,revision:number)=>app.inject({url,method:"PUT",headers:{...headers,"if-match":'"'+revision+'"'},payload})
  const initial=await get(base+"/return-policy")
  assert.equal(initial.statusCode,200,initial.body)
  for(const perm of ["fiscal.config.read","fiscal.config.manage","fiscal.certificate.manage"])await db.query("INSERT INTO role_permissions(role_id,permission_code) VALUES($1,$2) ON CONFLICT DO NOTHING",[role,perm])
  const profile={state:"SP",series:7,crt:1,municipalityCode:"3550308",stateRegistration:"123",environment:"homologation",nextNumber:12}
  const config=await set(base+"/config",profile,1);assert.equal(config.statusCode,200,config.body)
  assert.equal((await set(base+"/config",{...profile,nextNumber:1},2)).statusCode,409)
  const prefs={environment:"homologation",state:"SP",series:3,nextNumber:80,cscId:"03",csc:"0123456789ABCDEF"}
  const updated=await set(base+"/settings/nfce",prefs,1);assert.equal(updated.statusCode,200,updated.body)
  assert.ok(!updated.body.includes(prefs.csc));const {csc,...noSecret}=prefs
  assert.equal((await set(base+"/settings/nfce",{...noSecret,nextNumber:81},2)).statusCode,200)
  assert.equal((await set(base+"/settings/nfce",{...noSecret,environment:"production"},3)).statusCode,422)
  const cert={pkcs12Base64:"Zml4dHVyZQ==",password:"synthetic-only"}
  const installed=await set(base+"/certificate",cert,0);assert.equal(installed.statusCode,200,installed.body)
  assert.ok(!installed.body.includes(cert.password));assert.equal(installed.json().status,"expiring")
  assert.equal((await set(base+"/certificate",cert,0)).statusCode,412)
  const removed=await app.inject({method:"DELETE",url:base+"/certificate",headers:{...headers,"if-match":'"1"'}});assert.equal(removed.statusCode,200,removed.body)
  assert.equal(removed.json().status,"not_configured")
  const prefix="3526110425201100011055007000000055198765432",key=prefix+checkDigit(prefix)
  const xml='<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe Id="NFe'+key+'"><ide><mod>55</mod><tpAmb>2</tpAmb><serie>7</serie><tpNF>1</tpNF><nNF>55</nNF><dhEmi>2026-11-17T16:00:00-03:00</dhEmi></ide><emit><CNPJ>04252011000110</CNPJ><xNome>Emitente</xNome></emit><dest><CPF>52998224725</CPF><xNome>Cliente</xNome></dest><det nItem="1"/><total><ICMSTot><vNF>4.90</vNF></ICMSTot></total></infNFe></NFe><protNFe><infProt><tpAmb>2</tpAmb><cStat>100</cStat><chNFe>'+key+'</chNFe></infProt></protNFe></nfeProc>'
  const upload=(xml:string)=>app.inject({method:"POST",url:path+"/import",headers,payload:{xml}})
  const created=await upload(xml)
  assert.equal(created.statusCode,201,created.body)
  assert.equal((await upload(xml)).statusCode,200)
  assert.equal((await upload(xml.replace("Cliente","Destinatário alterado"))).statusCode,409)
  assert.equal((await upload(xml.replace("<tpNF>1","<tpNF>0"))).statusCode,422)
  const stored=created.json(),fetched=await get(path+"/"+stored.id)
  assert.deepEqual(fetched.json().data,stored,fetched.body)
  assert.equal((await get(path+"?q=52998224725&from=2026-11-17")).json().total,1)
  const download=await get(path+"/"+stored.id+"/xml")
  assert.equal(download.body,xml);assert.equal(download.headers["x-xml-sha256"],sha256(xml))
  const pdf=await get(path+"/"+stored.id+"/danfe");assert.equal(pdf.statusCode,200,pdf.body)
  assert.equal(pdf.headers["x-pdf-sha256"],sha256(pdf.rawPayload))
  assert.equal((await app.inject({url:base+"/danfe",method:"POST",headers,payload:{xml}})).statusCode,200)
}
