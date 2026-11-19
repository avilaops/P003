import { sameJson } from "../../platform/json.js"

// Earlier warranty commands stored the body by itself. The result carries the
// parent ID and post-command revision. Check both before accepting a replay.
const historical:Record<string,{scope:string;target?:string;revision?:string}>={
  "warranty.policy.created":{scope:"warranty.policy.create"},
  "warranty.case.opened":{scope:"warranty.case.create"},
  "warranty.case.assigned":{scope:"warranty.case.assignment",target:"id",revision:"revision"},
  "warranty.case.transitioned":{scope:"warranty.case.transition",target:"id",revision:"revision"},
  "warranty.service_order.created":{scope:"warranty.service-order.create",target:"caseId"},
  "warranty.service_order.part_added":{scope:"warranty.service-order.part.create",target:"serviceOrderId",revision:"revision"},
  "warranty.case.approval.created":{scope:"warranty.case.approval.create",target:"caseId",revision:"revision"},
  "warranty.rma.created":{scope:"warranty.rma.create",target:"caseId",revision:"revision"},
  "warranty.rma.transitioned":{scope:"warranty.rma.transition",target:"id",revision:"revision"},
  "warranty.quarantine.created":{scope:"warranty.quarantine.create",target:"caseId",revision:"caseRevision"},
  "warranty.quarantine.transitioned":{scope:"warranty.quarantine.transition",target:"id",revision:"revision"},
}
function comparable(body:unknown) {
  if(!body || typeof body!=="object" || Array.isArray(body)) return body
  return Object.fromEntries(Object.entries(body).filter(([,value])=>value!=null))
}
export function earlierWarrantyCommand(scope:string,id:string,revision:bigint|number,input:unknown) {
  const definition=historical[scope]
  if(!definition) return undefined
  return (saved:{scope:string;request:unknown;result:Record<string,unknown>})=>{
    if(saved.scope!==definition.scope || !sameJson(comparable(saved.request),comparable(input))) return false
    const data=saved.result.data as Record<string,unknown>|undefined
    if(!data || definition.target && data[definition.target]!==id) return false
    return !definition.revision || String(data[definition.revision])===String(BigInt(revision)+1n)
  }
}
