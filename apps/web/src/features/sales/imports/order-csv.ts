export const fields = [
  ["external","Pedido externo","pedido_externo"], ["customer","CPF/CNPJ do cliente","documento_cliente"],
  ["due","Vencimento","vencimento"], ["sku","SKU do produto","sku"], ["quantity","Quantidade","quantidade"],
  ["structureColor","Cor da estrutura","cor_estrutura"], ["swingArmColor","Cor do braço","cor_braco"],
  ["plateHolderColor","Cor do anilheiro","cor_anilheiro"], ["plateHolderType","Tipo de anilheiro","tipo_anilheiro"], ["upholsteryColor","Cor do estofado","cor_estofado"]
] as const
type Field=typeof fields[number][0]
export type Mapping=Partial<Record<Field,number>>
export type Csv={headers:string[];rows:{line:number;values:string[]}[]}
export function parseOrderCsv(input:string):Csv {
  const source=input.replace(/^\uFEFF/,"").replace(/\r\n?/g,"\n")
  let separator=",", headerQuote=false
  for(const char of source) {
    if(char==='"') headerQuote=!headerQuote
    if(!headerQuote && (char===";" || char===",")) {separator=char;break}
    if(!headerQuote && char==="\n") break
  }
  const records:Csv["rows"]=[]
  let values:string[]=[], cell="", quoted=false,closed=false,line=1,start=1
  function finish() {
    values.push(cell);cell="";closed=false
    if(values.some(x=>x.trim()!=="")) records.push({line:start,values})
    values=[];start=line+1
  }
  for(let i=0;i<source.length;i++) {
    const char=source[i]!
    if(quoted) {
      if(char==='"' && source[i+1]==='"') {cell+='"';i++}
      else if(char==='"') {quoted=false;closed=true}
      else {cell+=char;if(char==="\n")line++}
    } else if(char===separator) {values.push(cell);cell="";closed=false}
    else if(char==="\n") {finish();line++}
    else if(!cell && !closed && char==='"') quoted=true
    else if(closed || char==='"') throw Error(`Aspas inválidas na linha ${line}.`)
    else cell+=char
  }
  if(quoted) throw Error(`Aspas abertas na linha ${start}.`)
  finish()
  const headers=records.shift()?.values.map(value=>value.trim())
  if(!headers || !records.length || records.length>200) throw Error("Informe um cabeçalho e de 1 a 200 linhas de itens.")
  const invalid=records.find(row=>row.values.length!==headers.length)
  if(invalid) throw Error(`Número de colunas diferente do cabeçalho na linha ${invalid.line}.`)
  return {headers,rows:records}
}
export function defaultMapping(headers:string[]):Mapping {
  const result:Mapping={}
  for(const [key,,title] of fields) {
    const index=headers.findIndex(h=>h.trim().toLowerCase()===title)
    if(index>=0) result[key]=index
  }
  return result
}
export function mappedRows(csv:Csv,mapping:Mapping) {
  const selected=Object.values(mapping).filter(i=>i!==undefined && i>=0)
  if(fields.slice(0,5).some(([key])=>(mapping[key]??-1)<0) || new Set(selected).size!==selected.length) throw Error("Mapeie cada campo obrigatório para uma coluna diferente.")
  return csv.rows.map(row=>Object.fromEntries([["line",row.line],...fields.flatMap(([key])=>{
    const index=mapping[key]
    return index===undefined || index<0 ? [] : [[key,row.values[index]??""]]
  })]))
}
export const exportText=(value:string)=>/^[\s]*[=+@-]/.test(value)?"'"+value:value
