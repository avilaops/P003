export type LotEnvironment = "production" | "homologation"
export type FiscalLot = {
  id:string; draftId:string|null; legacyFull:boolean; status:string; environment:LotEnvironment
  accessKey:string|null; number:number|null; deliveredAt:string|null
  items:{lineNumber:number;sku:string;quantity:string}[]
}
export type OrderLots = {
  tenantId:string; orderId:string; status:string; environment:LotEnvironment
  lines:{lineNumber:number;sku:string;name:string;unit:string;ordered:string;available:string;allocated:string;billed:string;delivered:string;returned:string}[]
  lots:FiscalLot[]
  ownReturns?:{id:string;lotId:string;status:string;reason:string;destination:string;originalKey:string;receivedId:string|null;emissionStatus:string|null;decisionReason:string|null;canDecide:boolean}[]
  returnRequests?:{id:string;receivedId:string;destination:string;status:string;amountCents:string|null;reason:string;decisionReason:string|null;canDecide:boolean}[]
  returns:{id:string;lotId:string;receivedId:string;reason:string;destination:string;creditedCents:string|null;remainingCreditCents?:string|null;abatedCents:string|null;commissionReversedCents:string|null}[]
}
export function decimalMicros(value:string) {
  const micros=BigInt(value)
  return (micros/BigInt(1000000)).toString()+ "." +(micros%BigInt(1000000)).toString().padStart(6,"0").slice(0,4)
}
export function inputMicros(value:string) {
  const parts=/^(\d{1,12})(?:[,.](\d{1,4}))?$/.exec(value.trim())
  if (!parts) throw new Error("Informe uma quantidade com até quatro casas decimais")
  return (BigInt(parts[1])*BigInt(1000000)+BigInt((parts[2] || "").padEnd(6,"0"))).toString()
}
