"use client"
import {useState} from "react"
import {Input} from "@/components/ui/input"
import {Button} from "@/components/ui/button"
import {inputMicros,decimalMicros,type FiscalLot} from "./order-lots-model"
export function OwnReturnForm({lot,locked,send}:{lot:FiscalLot;locked:boolean;send:(v:object)=>Promise<void>}) {
  const [error,setError]=useState("")
  return <form className="grid max-w-2xl gap-3 rounded border p-3" onSubmit={e=>{
    e.preventDefault();setError("")
    const form=new FormData(e.currentTarget)
    try {
      const items=lot.items.filter(i=>String(form.get("q"+i.lineNumber)||"").trim()).map(i=>({lineNumber:i.lineNumber,quantityMicros:inputMicros(String(form.get("q"+i.lineNumber))),cfop:String(form.get("cfop"+i.lineNumber)||"").trim()}))
      if(!items.length || items.some(i=>i.quantityMicros==="0" || !/^[12]\d{3}$/.test(i.cfop)))throw Error("Informe a quantidade e o CFOP de entrada em cada linha selecionada")
      void send({action:"prepareOwnReturn",lotId:lot.id,items,reason:form.get("reason"),destination:form.get("destination"),taxRuleReference:form.get("rule"),consumerDeclaration:form.has("consumer")})
    }catch(cause){setError(cause instanceof Error?cause.message:"Confira os itens")}
  }}>
    <fieldset disabled={locked} className="grid gap-3"><legend className="font-medium">Emitir NF-e de entrada pela empresa</legend>
      {lot.items.map(i=><div key={i.lineNumber} className="grid gap-2 sm:grid-cols-2"><label>{i.sku} • quantidade da devolução<Input name={"q"+i.lineNumber} inputMode="decimal" placeholder={"Até "+decimalMicros(i.quantity).replace(".",",")}/></label>
        <label>CFOP de entrada • {i.sku}<Input name={"cfop"+i.lineNumber} inputMode="numeric" maxLength={4}/></label></div>)}
      <label>Motivo da devolução<Input name="reason" minLength={3} maxLength={200} required/></label>
      <label>Instrução do responsável fiscal<Input name="rule" minLength={3} maxLength={200} required/></label>
      <label>Destino dos itens<select name="destination" className="block min-h-10 w-full rounded border bg-background"><option value="stock">Estoque</option><option value="service">Assistência</option><option value="discard">Descarte</option></select></label>
      <label><input type="checkbox" name="consumer" required/> O consumidor não emite a nota de devolução.</label>
      {error && <p role="alert">{error}</p>}<Button type="submit">Preparar nota de entrada</Button>
    </fieldset>
  </form>
}
export const ownReturnStatus:Record<string,string>={pending:"Aguardando aprovação",ready:"Aguardando conclusão",applied:"Concluída",simulated:"Homologação concluída",declined:"Recusada",withdrawn:"Liberada"}
