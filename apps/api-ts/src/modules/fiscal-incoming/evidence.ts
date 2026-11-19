import type { AuthorizedContext } from "../../platform/access.js"
import { inspectDistributed } from "./distributed-xml.js"
import { recipient } from "./received.js"
export async function storedEvidence(c:AuthorizedContext,key:string,prod:boolean) {
  const tax=await recipient(c)
  const rows=(await c.client.query(prod?"SELECT nsu,xml FROM fiscal_monitor_documents WHERE tenant_id=$1 AND kind='event' AND (access_key=$2 OR access_key IS NULL AND strpos(xml,$2)>0) ORDER BY nsu DESC":"SELECT lpad(nsu::text,15,'0') AS nsu,xml FROM fiscal_distribution_documents WHERE tenant_id=$1 AND environment=2 AND kind='event' AND access_key=$2 ORDER BY nsu DESC",[c.tenantId,key])).rows
  return rows.flatMap(row=>{
    try {
      const read=inspectDistributed(String(row.xml),"event",tax,prod?1:2)
      return read.key===key && read.evidence?[{...read.evidence,nsu:String(row.nsu),xml:String(row.xml)}]:[]
    }catch{return []}
  })
}
