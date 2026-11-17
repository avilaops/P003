
import type { Schema } from "@/lib/api/types"
export const referenceConfigs = {
  "depositos": {
    title: "Depósitos de estoque", singular: "depósito", endpoint: "warehouses",
    create: "Novo depósito", plural: "depósitos",
    emptyText: "Depósitos identificam os locais físicos do estoque, como galpão, loja ou showroom.",
    description: "Cadastre e organize os depósitos da empresa. Os saldos atuais são consolidados por produto e empresa, sem divisão por depósito.",
    defaults: { code: "", name: "", status: "active", notes: null, location: null },
  },
  "grupos-produtos": {
    title: "Grupos de produtos", singular: "grupo de produtos", endpoint: "product-groups",
    create: "Novo grupo de produtos", plural: "grupos de produtos",
    emptyText: "Grupos juntam produtos para regras comerciais e relatórios, independentemente da categoria.",
    description: "Grupos de classificação da empresa. O cadastro não altera produtos ou saldos existentes.",
    defaults: { code: "", name: "", status: "active", notes: null },
  },
  "grupos-tags": {
    title: "Grupos de tags", singular: "grupo de tags", endpoint: "tag-groups",
    create: "Novo grupo de tags", plural: "grupos de tags",
    emptyText: "Grupos organizam as tags por assunto, como segmento de cliente ou origem do contato.",
    description: "Organize as tags da empresa em grupos. Para arquivar um grupo, mova ou arquive suas tags ativas.",
    defaults: { code: "", name: "", status: "active", notes: null },
  },
  "tags": {
    title: "Tags", singular: "tag", endpoint: "tags",
    create: "Nova tag", plural: "tags",
    emptyText: "Tags marcam clientes, produtos e pedidos para filtrar e segmentar.",
    description: "Cadastre tags e organize-as por grupo. Tags ativas só podem pertencer a grupos ativos.",
    defaults: { code: "", name: "", status: "active", notes: null, groupId: null },
  },
  "categorias-produtos": {
    title: "Categorias de produtos", singular: "categoria de produtos", endpoint: "product-categories",
    create: "Nova categoria de produtos", plural: "categorias de produtos",
    emptyText: "Categorias organizam o catálogo para consulta, tabela de preços e relatórios.",
    description: "Organize o catálogo em categorias e subcategorias. Os produtos usam esta classificação para consulta e edição.",
    defaults: { code: "", name: "", status: "active", notes: null, parentId: null, sortOrder: 0 },
  },
  "categorias-financeiras": {
    title: "Categorias financeiras", singular: "categoria financeira", endpoint: "financial-categories",
    create: "Nova categoria financeira", plural: "categorias financeiras",
    emptyText: "Categorias classificam receitas e despesas para relatórios e para o resultado da empresa.",
    description: "Classificação gerencial da empresa. Receitas e despesas possuem hierarquias separadas.",
    defaults: { code: "", name: "", status: "active", notes: null, parentId: null, direction: "income" },
  },
  "contas-financeiras": {
    title: "Contas financeiras", singular: "conta financeira", endpoint: "financial-accounts",
    create: "Nova conta financeira", plural: "contas financeiras",
    emptyText: "Cadastre as contas onde o dinheiro entra e sai: banco, caixa ou conta interna. Caixas e bancos e o PDV dependem delas.",
    description: "Cadastro de contas e caixas. Não consulta saldos nem estabelece conexão bancária.",
    defaults: { code: "", name: "", status: "active", notes: null, accountType: "bank", bank: null, branch: null, accountNumber: null },
  },
  "formas-pagamento": {
    title: "Formas de pagamento", singular: "forma de pagamento", endpoint: "payment-methods",
    create: "Nova forma de pagamento", plural: "formas de pagamento",
    emptyText: "Formas de pagamento são usadas nas propostas, nos pedidos e nos recebimentos.",
    description: "Modalidades e prazos de referência. O cadastro não executa pagamentos nem altera recebimentos existentes.",
    defaults: { code: "", name: "", status: "active", notes: null, modality: "pix", settlementDays: 0 },
  },
} as const

export type ReferenceKind = keyof typeof referenceConfigs
export const referencePath = (kind: ReferenceKind) => kind === "depositos" ? "/estoque/depositos" : `/cadastros/${kind}`
export type ReferenceFields = Omit<Schema<"Reference">, "id" | "revision"> & Record<string, string | number | null>
export type ReferenceRecord = Schema<"Reference"> & Record<string, string | number | null>
export type ReferenceSnapshot = Omit<Schema<"ReferenceSnapshot">, "data"> & { data: ReferenceRecord }
export type ReferenceList = Omit<Schema<"ReferenceList">, "data"> & { data: ReferenceRecord[] }
export const modalities = { pix: "Pix", cash: "Dinheiro", bank_transfer: "Transferência bancária", credit_card: "Cartão de crédito", debit_card: "Cartão de débito", boleto: "Boleto", other: "Outra" }
export const accountTypes = { bank: "Conta bancária", cash: "Caixa interno", internal: "Conta interna" }
