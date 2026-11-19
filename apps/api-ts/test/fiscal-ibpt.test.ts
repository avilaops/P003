import assert from "node:assert/strict"
import {createHash,randomUUID} from "node:crypto"
import {mkdtemp,rm,writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import test from "node:test"
import {ibptQuote,ibptSnapshot} from "../src/modules/fiscal-workspace/ibpt.js"
import type {DraftInput} from "../src/modules/fiscal-workspace/draft-schema.js"

test("IBPT • manifesto local por empresa, precisão e validade do snapshot",async()=>{
  const tenant=randomUUID(),dir=await mkdtemp(join(tmpdir(),"ibpt-fixture-")),file=join(dir,"manifest.json")
  try{
    const data={uf:"SP",classification:"ncm",version:"26.2.A",key:"TEST",source:"Fonte sintética",licenseReference:"TEST",validFrom:"2026-11-01",validTo:"2026-11-30",
      rows:[{code:"95069100",ex:"0",national:"10.0000",imported:"20.0000",state:"3.7500",municipal:"0.0000"}]}
    const bytes=JSON.stringify(data),hash=createHash("sha256").update(bytes).digest("hex")
    await writeFile(join(dir,"rates.json"),bytes)
    await writeFile(file,JSON.stringify([{tenantId:tenant,file:"rates.json",sha256:hash}]))
    const q={uf:"SP",classification:"ncm",asOf:"2026-11-18",code:"95069100",ex:"0",origin:"national",amount:"100.00"}
    assert.deepEqual((await ibptQuote(tenant,q,file)).amounts,{federal:"10.00",state:"3.75",municipal:"0.00",total:"13.75"})
    assert.equal((await ibptQuote(randomUUID(),q,file)).status,"not_configured")
    assert.equal((await ibptQuote(tenant,{...q,asOf:"2026-12-01"},file)).status,"outside_validity")
    assert.equal((await ibptQuote(tenant,{...q,code:"95069101"},file)).status,"code_not_found")
    const draft={issuedAt:"2026-11-18T17:00:00Z",items:[{code:"A",ncm:"95069100",grossTotal:"90.00",freightAmount:"10.00"}],ibpt:{uf:"SP",asOf:q.asOf,items:[{ex:"0",origin:"imported"}]}} as DraftInput
    const snapshot=await ibptSnapshot(tenant,draft,file)
    assert.equal(snapshot?.amounts.total,"23.75");assert.equal(snapshot?.items[0]?.metadata.sha256,hash)
    const corrupted=join(dir,"corrupted.json");await writeFile(corrupted,JSON.stringify([{tenantId:tenant,file:"rates.json",sha256:"0".repeat(64)}]))
    await assert.rejects(ibptQuote(tenant,q,corrupted))
  }finally{await rm(dir,{recursive:true,force:true})}
})
