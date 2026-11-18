"use client"

import Link from "next/link"
import {useState} from "react"
import {PageHeader} from "@/components/page-header"
import {Button} from "@/components/ui/button"
import {Input} from "@/components/ui/input"
import {Pagination} from "@/components/workspace/pagination"
import {useCommand,useResource} from "@/hooks/use-operation"
import {decimalPattern,normalizeDecimal} from "@/lib/decimal-input"
import {commercialQuantity} from "@/features/sales/order-presentation"
import {stockUrl,textLink} from "./stock-model"

const api="/api/erp/stock/replenishment",base="/compras/sugestoes"
type Product={productId:string;sku:string;name:string;unit:string;minimum:string;reorderPoint:string;purchaseLot:string;leadDays:number;
  available:string;acceptedDemand:string;openPurchases:string;netNeed:string;suggested:string;revision:number}
type Snapshot={tenantId:string;canEdit:boolean;data:Product}

export function Replenishment({tenant,id}:{tenant:string;id?:string|undefined}) {
  return id ? <Detail key={id} tenant={tenant} id={id}/> : <Listing tenant={tenant}/>
}
function Listing({tenant}:{tenant:string}) {
  const [q,setQ]=useState(""),[mode,setMode]=useState("needed"),[offset,setOffset]=useState(0)
  const list=useResource<{tenantId:string;data:Product[];total:number}>(stockUrl(api,{offset,limit:25,mode,q}))
  const value=list.value?.tenantId===tenant?list.value:null
  return <div className="workspace-page-frame"><PageHeader title="Sugestões de compra" back={{href:"/compras",label:"Compras"}}/>
    <section className="form-section space-y-3"><form className="flex flex-wrap items-end gap-3" onSubmit={event=>{
      event.preventDefault();setQ(String(new FormData(event.currentTarget).get("q")||""));setOffset(0)
    }}><label>Produto ou SKU<Input name="q" maxLength={160}/></label>
      <label>Exibir<select className="block min-h-9 rounded border px-2" value={mode} onChange={e=>{setMode(e.target.value);setOffset(0)}}>
        <option value="needed">Produtos a repor</option><option value="all">Todos os produtos</option></select></label><Button type="submit">Buscar</Button></form>
      {list.loading?<p role="status">Calculando sugestões…</p>:!value?<p role="alert">{list.error||"Recarregue a página da empresa ativa."}</p>:<>
        {value.data.length?<ul className="divide-y">{value.data.map(p=><li key={p.productId} className="py-3">
          <Link className={textLink} href={base+"/"+p.productId}>{p.name} • SKU {p.sku}</Link><p>Disponível • {commercialQuantity(p.available)} {p.unit}</p>
          <p>Compra sugerida • {commercialQuantity(p.suggested)} {p.unit}</p></li>)}</ul>:
          <p>{mode==="needed"?"Nenhuma necessidade de reposição para o filtro atual.":"Nenhum produto encontrado."}</p>}
        <Pagination offset={offset} total={value.total} pageSize={25} maxOffset={100000} onOffsetChange={setOffset}/>
      </>}
    </section></div>
}

function Detail({tenant,id}:{tenant:string;id:string}) {
  const result=useResource<Snapshot>(api+"/"+id),[notice,setNotice]=useState("")
  const value=result.value?.tenantId===tenant?result.value:null
  return <div className="workspace-page-frame"><PageHeader title={value?.data.name||"Reposição do produto"} back={{href:base,label:"Sugestões de compra"}}/>
    {notice&&<p role="status">{notice}</p>}
    {result.loading?<p role="status">Consultando posição…</p>:!value?<p role="alert">{result.error||"Produto indisponível nesta empresa."}</p>:<>
      <section className="form-section space-y-3"><h2 className="font-semibold">Cálculo da reposição • SKU {value.data.sku}</h2>
        <dl className="grid grid-cols-2 gap-3 md:grid-cols-3">{([["available","Disponível após reservas"],["acceptedDemand","Pedidos aceitos"],
          ["openPurchases","Compras a receber"],["minimum","Estoque mínimo"],["netNeed","Necessidade líquida"],["suggested","Compra sugerida"]] as const).map(([k,label])=>
          <div key={k}><dt>{label}</dt><dd className="font-medium">{commercialQuantity(value.data[k])} {value.data.unit}</dd></div>)}</dl>
        <Link href={stockUrl("/estoque/lancamentos",{tenant,productId:id,sku:value.data.sku})} className={textLink}>Ver movimentos</Link>
      </section>
      <Rule key={value.data.revision} data={value} refresh={result.reload} saved={()=>{setNotice("Regra de reposição salva.");result.reload()}}/>
    </>}
  </div>
}
function Rule({data,saved,refresh}:{data:Snapshot;saved:()=>void;refresh:()=>void}) {
  const cmd=useCommand(),[error,setError]=useState(""),p=data.data
  return <form className="form-section space-y-3" onSubmit={async event=>{
    event.preventDefault()
    const inputs=new FormData(event.currentTarget)
    const field=(key:string)=>normalizeDecimal(String(inputs.get(key)||""),6)
    const body={minimum:field("minimum"),reorderPoint:field("reorderPoint"),purchaseLot:field("purchaseLot"),leadDays:Number(inputs.get("leadDays")),revision:p.revision}
    if(!cmd.uncertain&&(!body.minimum||!body.reorderPoint||!body.purchaseLot)){setError("Confira as quantidades informadas.");return}
    setError("")
    const updated=await cmd.send<Snapshot>(api+"/"+p.productId,data.tenantId,body,"","PUT",r=>r.tenantId===data.tenantId&&r.data.productId===p.productId)
    if(updated)saved()
  }}><h2 className="font-semibold">Parâmetros do produto</h2>
    <fieldset disabled={!data.canEdit||cmd.busy||cmd.uncertain} className="grid gap-3 md:grid-cols-2">
      {([["minimum","Estoque mínimo"],["reorderPoint","Ponto de pedido"],["purchaseLot","Lote de compra"]] as const).map(([k,label])=>
        <label key={k}>{label} ({p.unit})<Input name={k} required inputMode="decimal" pattern={decimalPattern(6)} defaultValue={p[k].replace(/0+$/,"").replace(/\.$/,"").replace(".",",")}/></label>)}
      <label>Prazo do fornecedor (dias)<Input type="number" name="leadDays" min={0} max={3650} required defaultValue={p.leadDays}/></label>
    </fieldset>
    {(error||cmd.error)&&<p role="alert">{error||cmd.error}</p>}
    {cmd.stale&&<Button type="button" variant="outline" onClick={refresh}>Consultar revisão atual</Button>}
    {data.canEdit&&<Button type="submit" disabled={cmd.busy||cmd.stale}>{cmd.uncertain?"Repetir confirmação":"Salvar regra"}</Button>}
  </form>
}
