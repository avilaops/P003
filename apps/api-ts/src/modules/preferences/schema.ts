import { z } from "zod"

export const allowedFavoritePaths = [
  "/vendas/pedidos",
  "/compras/pedidos",
  "/cadastros/clientes-fornecedores",
  "/cadastros/produtos",
  "/financeiro/contas-receber",
  "/financeiro/contas-pagar",
] as const

export const allowedCharts = ["Ticket médio", "Valor faturado", "Pedidos de venda"] as const
export const allowedPeriods = ["7D", "30D", "3M", "6M", "12M"] as const

const unique = <T>(values: T[]) => new Set(values).size === values.length

export const dashboardLayoutSchema = z.strictObject({
  favoritePaths: z.array(z.enum(allowedFavoritePaths)).max(allowedFavoritePaths.length).refine(unique),
  charts: z.array(z.enum(allowedCharts)).max(3).refine(unique),
  period: z.enum(allowedPeriods),
})

export const preferencesInputSchema = z.strictObject({
  ownerKey: z.string().optional(),
  productPageSize: z.union([z.literal(10), z.literal(25), z.literal(50), z.literal(100)]),
  dashboardLayout: dashboardLayoutSchema.optional(),
})

export type DashboardLayout = z.infer<typeof dashboardLayoutSchema>
export type PreferencesInput = z.infer<typeof preferencesInputSchema>
