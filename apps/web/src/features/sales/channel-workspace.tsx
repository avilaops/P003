"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, type FormEvent } from "react"
import { PageHeader } from "@/components/page-header"
import { RequestError } from "@/components/feedback/session-recovery"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useCommand, useResource } from "@/hooks/use-operation"
import { Lookup, type Choice } from "./orders"

const endpoint="/api/erp/commercial/policies/store"
const link="text-primary underline"
const select="min-h-10 rounded border bg-background px-2"
type Mode="store"|"list"|"new"|"view"|"edit"
type Connector={code:string;name:string;enabled:boolean;keyActive:boolean;keyId:string|null;revision:number}
type Listing={id:string;title:string;productId:string;product:string;sku:string;reference:string;channel:string;status:string;revision:number;delivery:{action:string;status:string;reference:string|null}|null}
type Option={id:string;name:string}
type ChannelOrder={id:string;channel:string;external:string;number:string;reservedMicros:string;status:string}
type ChannelEvent={id:string;kind:string;channel:string;external:string;status:string;importId:string|null;orderId:string|null;availableReturns:{id:string;reason:string}[]|null}
type Data={tenantId:string;canConfigure:boolean;canEdit:boolean;keys:Option[];connectors:Connector[];listings:Listing[];orders:ChannelOrder[];events:ChannelEvent[];more:boolean}
type Save=(body:object,open?:boolean)=>Promise<void>
const labels:Record<string,string>={draft:"Rascunho",published:"Publicado",paused:"Pausado",pending:"Aguardando conector",confirmed:"Confirmado",failed:"Falhou",accepted:"Aceito",cancelled:"Cancelado",completed:"Concluído",order:"Pedido",cancel:"Cancelamento",return:"Devolução",reconciled:"Conciliado",awaiting_import:"Aguardando importação",awaiting_reconciliation:"Aguardando conciliação",publish:"Publicar",pause:"Pausar",sync:"Sincronizar"}
function label(value:string){return labels[value]??value}
function units(raw:string){const micros=BigInt(raw);return (micros/BigInt(1000000)).toString()+((micros%BigInt(1000000))?","+(micros%BigInt(1000000)).toString().padStart(6,"0").replace(/0+$/,""):"")}
const titles:Record<Mode,string>={store:"Loja virtual",list:"Anúncios",new:"Novo anúncio",view:"Anúncio",edit:"Editar anúncio"}

export function ChannelWorkspace({mode,id}:{mode:Mode;id?:string}){
 const router=useRouter()
 const [channel,setChannel]=useState(""),[offset,setOffset]=useState(0),[notice,setNotice]=useState("")
 const query=new URLSearchParams()
 if(channel)query.set("channel",channel)
 if(offset)query.set("offset",String(offset))
 const resource=useResource<Data>(endpoint+(id?"/"+encodeURIComponent(id):query.size?"?"+query:""))
 const command=useCommand(),data=resource.value,listing=data?.listings?.[0]
 const locked=command.busy||command.uncertain||command.stale
 const save:Save=async(body,open=false)=>{
  if(!data)return
  const result=await command.send<{tenantId:string;revision:number;id:string}>(endpoint,data.tenantId,body,"","POST",value=>value.tenantId===data.tenantId&&!!value.id)
  if(result){
   if(open){router.push("/vendas/anuncios/"+result.id);return}
   setNotice("Operação registrada.");resource.reload()
  }
 }
 return <main className="mx-auto max-w-5xl space-y-5 p-4">
 <PageHeader title={titles[mode]} breadcrumbs={[{label:"Vendas",href:"/vendas"},...(id||mode==="new"?[{label:"Anúncios",href:"/vendas/anuncios"}]:[]),{label:titles[mode]}]}/>
 <nav className="flex flex-wrap gap-4" aria-label="Canais de venda"><Link className={link} href="/vendas/loja-virtual">Loja virtual</Link><Link className={link} href="/vendas/anuncios">Anúncios</Link>{mode==="list"&&data?.canEdit&&<Link className={link} href="/vendas/anuncios/novo">Novo anúncio</Link>}</nav>
 {resource.loading?<p role="status">Consultando canais…</p>:resource.error?<RequestError message={resource.error} status={resource.status}/>:data&&<>
 {(mode==="store"||mode==="list")&&<label className="grid max-w-sm gap-1">Filtrar por canal<select className={select} value={channel} onChange={e=>{setChannel(e.target.value);setOffset(0)}}><option value="">Todos os canais</option>{data.connectors.map(c=><option key={c.code} value={c.code}>{c.name}</option>)}</select></label>}
 {mode==="store"&&<>
 <section className="form-section"><h2 className="font-semibold">Canais conectados</h2>{!data.connectors.length&&<p>Nenhum canal configurado.</p>}{data.connectors.map(c=><p key={c.code}>{c.name} • {c.code} • {c.enabled&&c.keyActive?"Ativo":c.enabled?"Chave revogada":"Desativado"}</p>)}
 {data.canConfigure&&<ConnectorForm data={data} save={save} locked={locked}/>}</section>
 <section className="form-section"><h2 className="font-semibold">Pedidos e reservas</h2>{!data.orders.length&&<p>Nenhum pedido conciliado neste canal.</p>}
 <ul className="divide-y">{data.orders.map(o=><li key={o.id} className="py-2"><Link className={link} href={"/vendas/pedidos/"+o.id}>Pedido {o.number}</Link> • {o.channel} • {o.external} • {label(o.status)} • {units(o.reservedMicros)} reservados</li>)}</ul></section>
 <section className="form-section"><h2 className="font-semibold">Eventos recebidos</h2>{!data.events.length&&<p>Nenhum evento recebido.</p>}
 <ul className="divide-y">{data.events.map(e=><li key={e.channel+"/"+e.id} className="space-y-2 py-3"><p>{label(e.kind)} {e.external} • {e.channel} • {label(e.status)}</p>
 {e.importId&&<Link className={link} href={"/vendas/importacao?job="+e.importId}>Conferir importação</Link>}{e.orderId&&<Link className={"ml-3 "+link} href={"/vendas/pedidos/"+e.orderId}>Abrir pedido</Link>}
 {e.kind==="return"&&e.status!=="reconciled"&&data.canEdit&&<>{e.availableReturns?.length?<form className="flex flex-wrap items-end gap-2" onSubmit={ev=>{ev.preventDefault();void save({kind:"return",channel:e.channel,eventId:e.id,returnId:new FormData(ev.currentTarget).get("return")})}}><label>Devolução do pedido<select className={select} required name="return" defaultValue=""><option value="">Selecione</option>{e.availableReturns.map(r=><option key={r.id} value={r.id}>{r.reason} • {r.id.slice(0,8)}</option>)}</select></label><Button type="submit" disabled={locked}>Conciliar devolução</Button></form>:<p>Registre a devolução fiscal no pedido para conciliá-la.</p>}</>}
 </li>)}</ul></section></>}
 {mode==="list"&&<section className="form-section"><h2 className="font-semibold">Anúncios por produto</h2>{!data.listings.length&&<p>Nenhum anúncio nesta seleção.</p>}<ul className="divide-y">{data.listings.map(l=><li key={l.id} className="py-2"><Link className={link} href={"/vendas/anuncios/"+l.id}>{l.title}</Link> • {l.sku} • {l.reference} • {l.channel} • {label(l.status)}{l.delivery&&" • "+label(l.delivery.status)}</li>)}</ul><div className="flex gap-2">{offset>0&&<Button variant="outline" onClick={()=>setOffset(offset-50)}>Anterior</Button>}{data.more&&<Button variant="outline" onClick={()=>setOffset(offset+50)}>Próxima</Button>}</div></section>}
 {(mode==="new"||mode==="edit")&&(data.canEdit?<ListingForm key={listing?.id??"new"} listing={mode==="edit"?listing:undefined} channels={data.connectors} save={save} locked={locked}/>:<p>A edição exige permissão de gestão de pedidos.</p>)}
 {mode==="view"&&listing&&<ListingDetail listing={listing} enabled={!!data.connectors.find(c=>c.code===listing.channel&&c.enabled&&c.keyActive)} canEdit={data.canEdit} save={save} locked={locked}/>}
 </>}
 {notice&&<p role="status">{notice}</p>}{command.error&&<p role="alert">{command.error}</p>}{command.uncertain&&<Button disabled={command.busy} onClick={()=>void save({},mode==="new"||mode==="edit")}>Repetir confirmação</Button>}{command.stale&&<Button onClick={()=>{command.reset();resource.reload()}}>Consultar revisão atual</Button>}
 </main>
}
function ConnectorForm({data,save,locked}:{data:Data;save:Save;locked:boolean}){
 const [code,setCode]=useState("")
 const c=data.connectors.find(v=>v.code===code)
 function submit(e:FormEvent<HTMLFormElement>){e.preventDefault();const f=new FormData(e.currentTarget);void save({kind:"connector",channel:f.get("code"),name:f.get("name"),keyId:f.get("key"),enabled:f.has("enabled"),revision:c?.revision??0})}
 return <details><summary className="cursor-pointer">Configurar conector</summary><form className="mt-3 grid gap-3 sm:grid-cols-2" onSubmit={submit}>
 <label>Conector<select className={select} value={code} onChange={e=>setCode(e.target.value)}><option value="">Novo conector</option>{data.connectors.map(v=><option key={v.code} value={v.code}>{v.name}</option>)}</select></label>
 <fieldset key={code} disabled={locked} className="contents"><label>Código do canal<Input name="code" pattern="[a-z0-9][a-z0-9_\-]{0,47}" required readOnly={!!c} defaultValue={c?.code}/></label><label>Nome<Input required maxLength={120} name="name" defaultValue={c?.name}/></label><label>Chave de serviço<select className={select} name="key" required defaultValue={c?.keyId??""}><option value="">Selecione uma chave ativa</option>{data.keys.map(k=><option key={k.id} value={k.id}>{k.name}</option>)}</select></label><label><input name="enabled" type="checkbox" defaultChecked={c?.enabled??true}/> Ativo</label></fieldset>
 <Link className={link} href="/preferencias/integracoes/lojas">Gerenciar chaves de serviço</Link><Button type="submit" disabled={locked||!data.keys.length}>Salvar conector</Button></form></details>
}
function ListingForm({listing,channels,save,locked}:{listing?:Listing;channels:Connector[];save:Save;locked:boolean}){
 const [product,setProduct]=useState<Choice|null>(null)
 function submit(e:FormEvent<HTMLFormElement>){e.preventDefault();const f=new FormData(e.currentTarget);void save({kind:"listing",...(listing?{id:listing.id}:{}),productId:listing?.productId??product?.id,channel:listing?.channel??f.get("channel"),reference:listing?.reference??f.get("reference"),title:f.get("title"),revision:listing?.revision??0},true)}
 return <form className="form-section" onSubmit={submit}><fieldset className="space-y-3" disabled={locked}>
 {listing?<p>{listing.product} • {listing.sku} • {listing.channel} • {listing.reference}</p>:<><label>Canal<select className={select} name="channel" required defaultValue=""><option value="">Selecione</option>{channels.map(c=><option key={c.code} value={c.code}>{c.name}</option>)}</select></label><Lookup endpoint="products" label="produto" disabled={locked} choose={setProduct} selectedName={product?.name} searchOnly/><label>Referência externa<Input required maxLength={120} name="reference"/></label></>}
 <label>Título do anúncio<Input required maxLength={120} name="title" defaultValue={listing?.title}/></label></fieldset><Button type="submit" disabled={locked||!listing&&!product}>Salvar anúncio</Button></form>
}
function ListingDetail({listing:l,enabled,canEdit,save,locked}:{listing:Listing;enabled:boolean;canEdit:boolean;save:Save;locked:boolean}){
 const [action,setAction]=useState("")
 return <section className="form-section"><h2 className="font-semibold">{l.title}</h2><p>{l.product} • {l.sku}</p><p>{l.channel} • {l.reference} • {label(l.status)}</p>
 {l.delivery&&<p>Última operação • {label(l.delivery.action)} • {label(l.delivery.status)}{l.delivery.reference&&" • "+l.delivery.reference}</p>}
 {canEdit&&l.delivery?.status!=="pending"&&<><Link className={link} href={"/vendas/anuncios/"+l.id+"/editar"}>Editar anúncio</Link>
 {enabled&&<div className="flex flex-wrap gap-2">{(l.status==="published"?["sync","pause"]:["publish"]).map(a=><Button key={a} variant="outline" disabled={locked} onClick={()=>setAction(a)}>{label(a)}</Button>)}</div>}</>}
 {action&&<div className="space-y-2"><p>{label(action)} este anúncio pelo conector {l.channel}? O estado será atualizado quando o conector responder.</p><Button disabled={locked} onClick={async()=>{await save({kind:"delivery",id:l.id,action,revision:l.revision});setAction("")}}>Confirmar operação</Button> <Button variant="outline" disabled={locked} onClick={()=>setAction("")}>Voltar</Button></div>}</section>
}
