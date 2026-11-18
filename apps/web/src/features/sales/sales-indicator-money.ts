export function formatCents(raw:number|string) {
  const amount=BigInt(raw)
  const cents=amount<0?-amount:amount
  return (amount<0?"−":"")+"R$ "+(cents/BigInt(100)).toLocaleString("pt-BR")+","+(cents%BigInt(100)).toString().padStart(2,"0")
}
