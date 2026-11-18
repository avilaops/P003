"use client"

import {useState} from "react"
import {Button} from "@/components/ui/button"
import {Input} from "@/components/ui/input"
import {useCommand,useResource} from "@/hooks/use-operation"
import {decimalPattern,normalizeDecimal} from "@/lib/decimal-input"
import {commercialQuantity} from "@/features/sales/order-presentation"
import type {StockList,StockProduct} from "@/features/inventory/stock-model"

type Item={productId:string;name:string;sku:string;unit:string;quantity:string}
type Version=Item&{version:number;actor:string;createdAt:string}
type Structure={tenantId:string;version:number;canEdit:boolean;components:Version[]}
type Props={tenant:string}
function Picker({tenant,label,choose}:{tenant:string;label:string;choose:(p:StockProduct)=>void}){
  const [q,setQ]=useState(""),result=useResource<StockList>("/api/erp/stock?limit=20&status=active&q="+encodeURIComponent(q))
  return <div><label>{label}<Input type="search" value={q} onChange={e=>setQ(e.target.value)} maxLength={160}/></label>
    {q&&result.value?.tenantId===tenant&&<ul className="max-h-48 overflow-auto">{result.value.data.map(p=>
      <li key={p.productId}><Button type="button" variant="ghost" onClick={()=>{choose(p);setQ("")}}>{p.name} • {p.sku}</Button></li>)}</ul>}
    {result.error&&<p role="alert">{result.error}</p>}</div>
}
export function Structures({tenant}:Props){
  const [product,setProduct]=useState<StockProduct|null>(null)
  return <details className="form-section space-y-3"><summary>Estruturas de produto</summary>
    <Picker tenant={tenant} label="Buscar produto acabado" choose={setProduct}/>
    {product&&<Versions key={product.productId} tenant={tenant} product={product}/>}
  </details>
}
function Versions({tenant,product}:{tenant:string;product:StockProduct}){
  const url="/api/erp/production/structures/"+product.productId,result=useResource<Structure>(url)
  const data=result.value?.tenantId===tenant?result.value:null
  const [notice,setNotice]=useState("")
  return <div className="space-y-2"><h3 className="font-medium">{product.name} • {product.sku}</h3>
    {notice&&<p role="status">{notice}</p>}
    {result.loading?<p role="status">Consultando estrutura…</p>:!data?<p role="alert">{result.error||"Consulta de estrutura indisponível."}</p>:<>
      <p>{data.version?"Versão vigente • "+data.version:"Primeira estrutura deste produto"}</p>
      {data.canEdit&&<Editor key={data.version} tenant={tenant} product={product} data={data} url={url} refresh={result.reload}
        saved={()=>{setNotice("Versão da estrutura publicada.");result.reload()}}/>}
      {data.components.length>0&&<details><summary>Histórico de versões</summary><ul>{data.components.map(c=>
        <li key={c.version+c.productId}>Versão {c.version} • {c.name} • {commercialQuantity(c.quantity)} {c.unit} • {c.actor}</li>)}</ul></details>}
    </>}</div>
}
function Editor({tenant,product,data,url,saved,refresh}:{tenant:string;product:StockProduct;data:Structure;url:string;saved:()=>void;refresh:()=>void}){
  const [items,setItems]=useState<Item[]>(data.components.filter(c=>c.version===data.version))
  const cmd=useCommand(),[error,setError]=useState("")
  return <form className="space-y-3" onSubmit={async e=>{
    e.preventDefault()
    const components=items.map(c=>({productId:c.productId,quantity:normalizeDecimal(c.quantity,6)}))
    if(!components.length||components.some(c=>!c.quantity||c.quantity==="0.000000")){setError("Informe quantidades positivas para os componentes.");return}
    setError("")
    if(await cmd.send(url,tenant,{previousVersion:data.version,components},"","POST",(r:{version:number;tenantId:string})=>r.tenantId===tenant&&r.version===data.version+1))saved()
  }}><fieldset disabled={cmd.busy||cmd.uncertain} className="space-y-2">
    <Picker tenant={tenant} label="Buscar componente da estrutura" choose={p=>{
      if(p.productId===product.productId||items.some(c=>c.productId===p.productId)){setError("Selecione um componente distinto.");return}
      setError("");setItems([...items,{...p,quantity:"1"}])
    }}/>
    {items.map(c=><div key={c.productId} className="flex flex-wrap items-end gap-2">
      <label>{c.name} • Quantidade por {product.unit} ({c.unit})<Input required inputMode="decimal" pattern={decimalPattern(6)}
        value={c.quantity} onChange={e=>setItems(items.map(i=>i.productId===c.productId?{...c,quantity:e.target.value}:i))}/></label>
      <Button type="button" variant="outline" onClick={()=>setItems(items.filter(i=>i.productId!==c.productId))}>Remover {c.sku}</Button></div>)}
    </fieldset>{(cmd.error||error)&&<p role="alert">{cmd.error||error}</p>}
    {cmd.stale&&<Button type="button" onClick={refresh}>Consultar versão atual</Button>}
    <Button type="submit" disabled={cmd.busy||cmd.stale||!items.length}>{cmd.uncertain?"Repetir confirmação":"Publicar versão da estrutura"}</Button>
  </form>
}
