const product = {sku:"SKU",product:"Produto",unit:"Unidade"}
const sources = {
  stock_position: {label:"Posição valorizada",method:"Saldo físico e reservas atuais de vendas e produção. Valores em reais pelo custo médio ponderado.",columns:{...product,quantity:"Saldo",reserved:"Reservado",available:"Disponível",cost:"Custo médio (R$)",value:"Valor em estoque (R$)"}},
  stock_kardex: {label:"Kardex por produto",method:"Movimentos em ordem de data efetiva. A abertura inclui a posição anterior ao período. O saldo após cada movimento respeita o depósito selecionado.",columns:{...product,date:"Data efetiva",warehouse:"Depósito",kind:"Tipo",document:"Documento de origem",reason:"Motivo",opening:"Saldo anterior",receipts:"Entrada",issues:"Saída",closing:"Saldo após movimento",cost:"Custo unitário (R$)",value:"Valor do movimento (R$)"}},
  stock_turnover: {label:"Giro e cobertura",method:"Por SKU, o giro divide as saídas líquidas de consumo e venda pela média simples dos saldos inicial e final. A cobertura divide o saldo final pela demanda média diária nos dias corridos do período. Transferências e ajustes de inventário ficam fora da demanda.",columns:{...product,opening:"Saldo inicial",closing:"Saldo final",demand:"Consumo líquido",average:"Saldo médio",turnover:"Giro no período",coverage:"Cobertura (dias)"}},
  stock_idle: {label:"Itens parados",method:"Produtos com saldo positivo e sem saídas de consumo ou venda nos últimos N dias corridos, incluindo a data final. Estornos integrais anulam a saída original. Uma data em branco indica ausência de saída registrada.",columns:{...product,quantity:"Saldo",last_issue:"Última saída válida",idle_days:"Dias desde a saída",history:"Histórico"}},
  stock_divergences: {label:"Divergências de inventário",method:"Linhas contadas com diferença em inventários aprovados no período. A diferença é a quantidade contada menos a esperada.",columns:{...product,date:"Aprovação",reference:"Inventário",warehouse:"Depósito",expected:"Esperado",counted:"Contado",difference:"Diferença"}},
  stock_abc: {label:"ABC de estoque",method:"Valor do estoque na data final, do maior para o menor. A classe usa a participação acumulada anterior ao item: A abaixo de 80%, B abaixo de 95% e C nos demais. Valores desconhecidos não participam da base.",columns:{...product,quantity:"Saldo",value:"Valor em estoque (R$)",share:"Participação (%)",cumulative:"Acumulado (%)",class:"Classe ABC"}},
  stock_accuracy: {label:"Acurácia de inventário",method:"Percentual de linhas contadas sem diferença sobre as linhas contadas em inventários aprovados no período. Sem contagens, o percentual é indeterminado.",columns:{lines:"Linhas contadas",matched:"Linhas concordantes",accuracy:"Acurácia (%)"}},
} as const
export type StockDataset=keyof typeof sources
export const stockCatalog:Record<StockDataset,{label:string;method:string;columns:Record<string,string>}>=sources
export function stockSource(id:string): id is StockDataset {return Object.hasOwn(stockCatalog,id)}
export function countSource(id:string) {return id==="stock_divergences" || id==="stock_accuracy"}
export const stockPermission=(id:string)=>countSource(id)?"inventory.counts.read":"inventory.stock.read"
export function visibleStockCatalog(permissions:string[]) {
  return Object.fromEntries(Object.entries(stockCatalog).filter(([key])=>permissions.includes("inventory.stock.read")&&permissions.includes(stockPermission(key))))
}

