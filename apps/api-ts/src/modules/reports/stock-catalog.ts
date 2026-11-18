const product = {sku:"SKU",product:"Produto",unit:"Unidade"}
const sources = {
  stock_position: {label:"Posição valorizada",method:"Saldo físico e reservas atuais de vendas e produção. Valores em reais pelo custo médio ponderado.",columns:{...product,quantity:"Saldo",reserved:"Reservado",available:"Disponível",cost:"Custo médio (R$)",value:"Valor em estoque (R$)",status:"Situação"}},
  stock_kardex: {label:"Kardex por produto",method:"Movimentos em ordem de data efetiva. A abertura inclui a posição anterior ao período. O saldo após cada movimento respeita o depósito selecionado.",columns:{...product,date:"Data efetiva",warehouse:"Depósito",kind:"Tipo",document:"Documento de origem",reason:"Motivo",opening:"Saldo anterior",receipts:"Entrada",issues:"Saída",closing:"Saldo após movimento",cost:"Custo unitário (R$)",value:"Valor do movimento (R$)"}},
  stock_turnover: {label:"Giro e cobertura",method:"Por SKU, o giro divide as saídas líquidas de consumo e venda pela média simples dos saldos inicial e final. A cobertura divide o saldo final pela demanda média diária nos dias corridos do período. Transferências e ajustes de inventário ficam fora da demanda.",columns:{...product,opening:"Saldo inicial",closing:"Saldo final",demand:"Consumo líquido",average:"Saldo médio",turnover:"Giro no período",coverage:"Cobertura (dias)"}},
  stock_idle: {label:"Itens parados",method:"A inatividade começa na última saída válida ou no início do saldo positivo atual, o que ocorrer depois. Um estorno integral anula a saída original. Aberturas sem data e sem saída identificável têm duração indeterminada.",columns:{...product,quantity:"Saldo",last_issue:"Última saída válida",positive_since:"Saldo positivo desde",idle_days:"Dias de inatividade",history:"Histórico"}},
  stock_divergences: {label:"Divergências de inventário",method:"Linhas contadas com diferença em inventários aprovados no período. A diferença é a quantidade contada menos a esperada.",columns:{...product,date:"Aprovação",reference:"Inventário",warehouse:"Depósito",expected:"Esperado",counted:"Contado",difference:"Diferença"}},
  stock_abc: {label:"ABC de estoque",method:"Valor do estoque na data final, do maior para o menor. A classe usa a participação acumulada anterior ao item: A abaixo de 80%, B abaixo de 95% e C nos demais. Valores desconhecidos não participam da base.",columns:{...product,quantity:"Saldo",value:"Valor em estoque (R$)",share:"Participação (%)",cumulative:"Acumulado (%)",class:"Classe ABC"}},
  stock_accuracy: {label:"Acurácia de inventário",method:"Percentual de linhas contadas sem diferença sobre as linhas contadas em inventários aprovados no período. Sem contagens, o percentual é indeterminado.",columns:{lines:"Linhas contadas",matched:"Linhas concordantes",accuracy:"Acurácia (%)"}},
  stock_movement_activity: {
    label:"Atividade de movimentação",
    method:"Entradas e saídas por data efetiva, depósito e unidade. Cada lançamento conta como um movimento, inclusive transferências e estornos.",
    columns:{date:"Data efetiva",warehouse:"Depósito",unit:"Unidade",receipts:"Quantidade de entrada",issues:"Quantidade de saída",receipt_count:"Entradas",issue_count:"Saídas",movements:"Movimentos"},
  },
  stock_count_progress: {
    label:"Progresso dos inventários",
    method:"Sessões abertas no período, com situação atual e percentual de linhas contadas. Ao selecionar um SKU, o progresso considera somente as linhas desse produto.",
    columns:{date:"Data de abertura",reference:"Inventário",warehouse:"Depósito",status:"Situação",lines:"Linhas",counted_lines:"Linhas contadas",pending_lines:"Linhas pendentes",progress:"Progresso (%)"},
  },
  stock_production_progress: {
    label:"Andamento da produção",
    method:"Ordens de produção abertas no período, agrupadas pela etapa e situação atuais, produto acabado e unidade. A quantidade é a planejada nas ordens. O depósito corresponde ao registrado na ordem.",
    columns:{stage:"Etapa",status:"Situação",...product,orders:"Ordens",quantity:"Quantidade planejada"},
  },
} as const
export type StockDataset=keyof typeof sources
export const stockCatalog:Record<StockDataset,{label:string;method:string;columns:Record<string,string>}>=sources
export function stockSource(id:string): id is StockDataset {return Object.hasOwn(stockCatalog,id)}
export function countSource(id:string) {return id==="stock_divergences" || id==="stock_accuracy" || id==="stock_count_progress"}
export function stockPermission(id:string) {
  if(countSource(id))return "inventory.counts.read"
  if(id==="stock_production_progress")return "production.read"
  return "inventory.stock.read"
}
export function visibleStockCatalog(permissions:string[]) {
  return Object.fromEntries(Object.entries(stockCatalog).filter(([key])=>permissions.includes("inventory.stock.read")&&permissions.includes(stockPermission(key))))
}
