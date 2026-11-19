import type { AuthorizedContext } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"

export type MergeEntity = "party" | "product"
export const entityTable: Record<MergeEntity, string> = { party: "parties", product: "products" }

type Link = { rel: string; col: string; tenant: boolean }
/** Descobre no catálogo do banco toda tabela que referencia o registro: novas tabelas entram na mesclagem sem mexer aqui. */
async function links(context: AuthorizedContext, entity: MergeEntity): Promise<Link[]> {
  const { rows } = await context.client.query<Link>(`
    SELECT c.conrelid::regclass::text AS rel, a.attname AS col,
           EXISTS(SELECT 1 FROM pg_attribute t WHERE t.attrelid=c.conrelid AND t.attname='tenant_id' AND NOT t.attisdropped) AS tenant
    FROM pg_constraint c
    CROSS JOIN LATERAL unnest(c.conkey, c.confkey) AS k(src, dst)
    JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.src
    JOIN pg_attribute r ON r.attrelid=c.confrelid AND r.attnum=k.dst
    JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE c.contype='f' AND c.confrelid=$1::regclass AND r.attname='id' AND a.attname<>'tenant_id' AND c.conrelid<>c.confrelid
      AND has_schema_privilege(n.nspname,'USAGE') AND has_table_privilege(c.conrelid,'UPDATE') -- arquivos somente leitura (ex.: legacy_evolution) ficam de fora
    ORDER BY 1,2`, [entityTable[entity]])
  return rows
}
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"'
const quoteRelation = (name: string) => name.includes(".") && !name.startsWith('"') ? name.split(".").map(quote).join(".") : name

/** Move todos os vínculos do secundário para o principal na transação do pedido e arquiva o secundário. */
export async function mergeRecords(context: AuthorizedContext, entity: MergeEntity, primaryId: string, secondaryId: string) {
  const moved: Record<string, number> = {}
  for (const link of await links(context, entity)) {
    const sql = `UPDATE ${quoteRelation(link.rel)} SET ${quote(link.col)}=$1 WHERE ${quote(link.col)}=$2${link.tenant ? " AND tenant_id=$3" : ""} RETURNING 1 AS n`
    try {
      const result = await context.client.query(sql, link.tenant ? [primaryId, secondaryId, context.tenantId] : [primaryId, secondaryId])
      if (result.rows.length) moved[link.rel + "." + link.col] = result.rows.length
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code && /^(23|P0)/.test(code)) throw new Problem(409, "domain_conflict", `Os dois registros têm dados próprios em ${link.rel} que não podem ser combinados. Resolva esse vínculo antes de mesclar`)
      throw error
    }
  }
  return moved
}
