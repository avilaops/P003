import { z } from "zod"
import { Problem } from "../../platform/problem.js"
import type { AuthorizedContext } from "../../platform/access.js"

const pageNumber = (max: number) =>
  z
    .string()
    .regex(/^\d{1,8}$/)
    .transform(Number)
    .pipe(z.number().int().max(max))
export const portfolioFilters = z
  .object({
    side: z.enum(["receivable", "payable"]).optional(),
    partyId: z.guid().optional(),
    categoryId: z.guid().optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    q: z.string().trim().min(1).max(120).optional(),
    status: z.enum(["open", "paid", "cancelled"]).optional(),
    bucket: z.enum(["future", "today", "1_30", "31_60", "61_90", "over90"]).optional(),
    limit: pageNumber(250).pipe(z.number().min(1)).optional(),
    offset: pageNumber(99999999).optional(),
  })
  .strict()

export function validate<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success)
    throw new Problem(
      422,
      "invalid_input",
      "Confira os campos informados • " +
        result.error.issues
          .map((issue) => issue.path.join("."))
          .filter(Boolean)
          .slice(0, 3)
          .join(", "),
    )
  return result.data
}
export function sides(context: AuthorizedContext) {
  const allowed = ["receivable", "payable"].filter((side) => context.permissions.includes("finance." + side + "s.read"))
  if (!allowed.length) throw new Problem(403, "forbidden", "Seu perfil precisa de acesso a uma das carteiras financeiras")
  return allowed
}
export const decimal = (expression: string) => `((${expression})::numeric / 100)::numeric(30,2)::text`
export const today = "(current_timestamp AT TIME ZONE 'America/Sao_Paulo')::date"
export const bucketSql = `CASE WHEN open_cents=0 THEN NULL WHEN due_date>${today} THEN 'future'
  WHEN due_date=${today} THEN 'today' WHEN due_date>=${today}-30 THEN '1_30' WHEN due_date>=${today}-60 THEN '31_60'
  WHEN due_date>=${today}-90 THEN '61_90' ELSE 'over90' END`

type PortfolioFilter = z.output<typeof portfolioFilters>
type PortfolioResult = {
  total: number
  companyName: string
  asOf: string
  totals: {
    receivable: string; payable: string; overdueReceivable: string; overduePayable: string
    weekReceivable: string; weekPayable: string; openReceivables: number; openPayables: number; futureMovementTitles: number
  }
  buckets: { bucket: string; count: number; receivable: string; payable: string }[]
  rows: {
    id: string; side: "receivable" | "payable"; party: string; partyId: string | null; orderId: string | null
    operationId: string | null; categoryId: string | null; competenceOn: string; dueDate: string
    amount: string; settled: string; outstanding: string; operationalOutstanding: string; nextMovementOn: string | null
    status: string; bucket: string | null; revision: string
  }[]
}
export async function portfolio(context: AuthorizedContext, filters: PortfolioFilter, allRows = false) {
  if (filters.from && filters.to && filters.from > filters.to) throw new Problem(422, "invalid_input", "Início posterior ao fim")
  const allowed = sides(context)
  if (filters.side && !allowed.includes(filters.side)) throw new Problem(403, "forbidden", "Carteira sem permissão de consulta")
  const amounts = `${decimal("coalesce(sum(open_cents) FILTER(WHERE side='receivable'),0)")} AS receivable,
                   ${decimal("coalesce(sum(open_cents) FILTER(WHERE side='payable'),0)")} AS payable`
  const result = await context.client.query<PortfolioResult>(
    `WITH scoped AS (
    SELECT p.*, ${bucketSql} AS bucket
    FROM finance_portfolio_today p WHERE tenant_id=$1 AND side=ANY($2::text[]) AND exists_today
      AND ($3::uuid IS NULL OR party_id=$3) AND ($4::uuid IS NULL OR category_id=$4)
      AND ($5::date IS NULL OR due_date >= $5) AND ($6::date IS NULL OR due_date <= $6)
      AND ($7::text IS NULL OR strpos(lower(party_name),lower($7))>0) AND ($8::text IS NULL OR status=$8)
  ), filtered AS (SELECT * FROM scoped WHERE $9::text IS NULL OR bucket=$9),
  totals AS (SELECT ${amounts}, count(*)::int AS total, count(next_movement_on)::int AS "futureMovementTitles",
      count(*) FILTER (WHERE side='receivable' AND open_cents>0)::int AS "openReceivables",
      count(*) FILTER (WHERE side='payable' AND open_cents>0)::int AS "openPayables",
      ${decimal("coalesce(sum(open_cents) FILTER(WHERE side='receivable' AND due_date<" + today + "),0)")} AS "overdueReceivable",
      ${decimal("coalesce(sum(open_cents) FILTER(WHERE side='payable' AND due_date<" + today + "),0)")} AS "overduePayable"
      ,${decimal("coalesce(sum(open_cents) FILTER(WHERE side='receivable' AND due_date BETWEEN " + today + " AND " + today + "+6),0)")} AS "weekReceivable"
      ,${decimal("coalesce(sum(open_cents) FILTER(WHERE side='payable' AND due_date BETWEEN " + today + " AND " + today + "+6),0)")} AS "weekPayable"
      FROM filtered),
  buckets AS (SELECT bucket,${amounts},count(*)::int AS count FROM filtered WHERE bucket IS NOT NULL GROUP BY bucket),
  page AS (SELECT id,side,party_name AS party,party_id AS "partyId",order_id AS "orderId",finance_operation_id AS "operationId",
      category_id AS "categoryId", competence_on::text AS "competenceOn",due_date::text AS "dueDate",
      ${decimal("amount_cents")} AS amount,${decimal("settled_cents")} AS settled,${decimal("open_cents")} AS outstanding,
      ${decimal("operational_open_cents")} AS "operationalOutstanding",next_movement_on::text AS "nextMovementOn",
      status,bucket,revision::text AS revision FROM filtered ORDER BY due_date,side,id LIMIT $10 OFFSET $11)
  SELECT (SELECT legal_name FROM tenants WHERE id=$1) AS "companyName",total,to_jsonb(totals)-'total' AS totals,${today}::text AS "asOf",
    coalesce((SELECT jsonb_agg(to_jsonb(page) ORDER BY "dueDate",side,id) FROM page),'[]') AS rows,
    coalesce((SELECT jsonb_agg(to_jsonb(buckets) ORDER BY bucket) FROM buckets),'[]') AS buckets FROM totals`,
    [
      context.tenantId,
      filters.side ? [filters.side] : allowed,
      filters.partyId ?? null,
      filters.categoryId ?? null,
      filters.from ?? null,
      filters.to ?? null,
      filters.q ?? null,
      filters.status ?? null,
      filters.bucket ?? null,
      allRows ? null : (filters.limit ?? 30),
      allRows ? 0 : (filters.offset ?? 0),
    ],
  )
  return { tenantId: context.tenantId, allowed, ...result.rows[0]! }
}
