"use client"

import { Input } from "@/components/ui/input"
import type { TaxProfileDefaults } from "./tax-profile-model"

export function TaxProfileDefaultFields({ index, value, onChange }: {
  index: number
  value: TaxProfileDefaults
  onChange: (value: TaxProfileDefaults) => void
}) {
  const codes = [
    ["icmsCst", "CST do ICMS", ["00", "40", "41", "50"]],
    ["pisCst", "CST do PIS", ["01", "02", "04", "05", "06", "07", "08", "09"]],
    ["cofinsCst", "CST da COFINS", ["01", "02", "04", "05", "06", "07", "08", "09"]],
    ["ipiCst", "CST do IPI", ["00", "49", "50", "99", "01", "02", "03", "04", "05", "51", "52", "53", "54", "55"]]
  ] as const
  return <fieldset className="col-span-full grid min-w-0 grid-cols-2 gap-2 border-t pb-1 pt-2 lg:grid-cols-5">
    <legend className="px-1 text-xs font-semibold">Códigos e padrões da nota</legend>
    {codes.map(([key, label, options]) => <label key={key} className="grid min-w-0 content-start gap-1 text-xs font-medium">
      {label}
      <select aria-label={`Perfil ${index + 1}: ${label}`} className="h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-xs font-normal" value={value[key] ?? ""} onChange={event => onChange({ ...value, [key]: event.target.value || undefined })}>
        <option value="">Não preencher</option>
        {options.map(code => <option key={code} value={code}>{code}</option>)}
      </select>
    </label>)}
    <label className="grid min-w-0 content-start gap-1 text-xs font-medium">Enquadramento do IPI
      <Input className="h-8 text-xs" aria-label={`Perfil ${index + 1}: Enquadramento do IPI`} inputMode="numeric" maxLength={3} pattern="[0-9]{3}" value={value.ipiFrameCode ?? ""} onChange={event => onChange({ ...value, ipiFrameCode: event.target.value || undefined })} />
    </label>
    <div className="col-span-full grid grid-cols-2 gap-2 lg:grid-cols-3">
    {([["ibsStateRate", "IBS estadual (%)"], ["ibsCityRate", "IBS municipal (%)"], ["cbsRate", "CBS (%)"]] as const).map(([key, label]) => <label key={key} className="grid min-w-0 content-start gap-1 text-xs font-medium">
      {label}
      <Input className="h-8 text-xs" aria-label={`Perfil ${index + 1}: ${label}`} inputMode="decimal" maxLength={7} pattern="[0-9]{1,2}([.][0-9]{1,4})?" value={value[key] ?? ""} onChange={event => onChange({ ...value, [key]: event.target.value.replace(",", ".") || undefined })} />
    </label>)}
    </div>
    <h3 className="col-span-full border-t pt-2 text-xs font-semibold">Composição das bases</h3>
    <div className="col-span-full grid gap-2 sm:grid-cols-3">
    {([["finalConsumer", "Consumidor final"], ["ipiInIcmsBase", "IPI na base do ICMS para consumidor final"], ["icmsOutOfContributions", "Excluir ICMS da base de PIS/COFINS"]] as const).map(([key, label]) => <label key={key} className="grid min-w-0 content-start gap-1 text-xs font-medium">
      {label}
      <select aria-label={`Perfil ${index + 1}: ${label}`} className="h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-xs font-normal" value={value[key] === undefined ? "" : String(value[key])} onChange={event => onChange({ ...value, [key]: event.target.value === "" ? undefined : event.target.value === "true" })}>
        <option value="">Não preencher</option><option value="true">Sim</option><option value="false">Não</option>
      </select>
    </label>)}
    </div>
    <p className="col-span-full text-xs font-normal leading-5 text-muted-foreground">Esses padrões completam campos vazios ao aplicar o perfil. CFOP, origem, contribuinte do ICMS e alíquotas de ICMS/IPI dependem do produto e da operação.</p>
  </fieldset>
}
