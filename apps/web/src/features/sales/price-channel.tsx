"use client"
import {useResource} from "@/hooks/use-operation"
import type {PolicyCatalog} from "./policy-settings"
import type {Sale} from "./negotiation-types"
export function SalesPriceChannel({value,onChange,disabled}:{value:string;onChange:(value:string)=>void;disabled:boolean}){
 const result=useResource<PolicyCatalog>("/api/erp/commercial/policies/catalog")
 if(!result.value?.channels?.length)return null
 return <label className="grid max-w-xs gap-1 text-sm">Canal comercial<select className="min-h-10 rounded border bg-background px-2" value={value} disabled={disabled} onChange={e=>onChange(e.target.value)}><option value="">Venda direta</option>{result.value.channels.map(c=><option key={c.channel}>{c.channel}</option>)}</select></label>
}
export function ItemPriceOrigins({items}:{items:Sale["items"]}){
 const custom=items.filter(i=>i.priceOrigin)
 return custom.length?<ul aria-label="Preços aplicados" className="text-sm">{custom.map(i=><li key={i.productId}>{i.sku} • {i.priceOrigin!.kind==="customer"?"Lista do cliente":"Lista do canal"} • {i.priceOrigin!.name} • Base {(i.tableUnitCents/100).toLocaleString("pt-BR",{style:"currency",currency:"BRL"})}</li>)}</ul>:null
}
