import { defineSource } from "../source.js"

const like = (value: unknown) => typeof value !== "string" ? null : "%" + value.replace(/[\\%_]/g, m => "\\" + m) + "%"

/** Auditoria: trilha de alterações e operações sensíveis da empresa. */
export const auditLogSource = defineSource({
  id: "audit_log",
  label: "Trilha de auditoria",
  area: "auditoria",
  description: "Ações registradas na empresa, com data, usuário, ação e registro afetado.",
  permissions: ["platform.audit.read"],
  columns: {
    occurred_at: { label: "Data e hora", type: "datetime" },
    occurred_on: { label: "Data", type: "date", groupable: true },
    actor: { label: "Usuário", type: "text", groupable: true },
    action: { label: "Ação", type: "text", groupable: true },
    entity_type: { label: "Entidade", type: "text", groupable: true },
    entity_id: { label: "Registro", type: "text" },
  },
  filters: {
    period: { kind: "period", label: "Período", required: true },
    action: { kind: "text", label: "Ação contém" },
    entity_type: { kind: "text", label: "Entidade contém" },
    actor: { kind: "text", label: "Usuário contém" },
  },
  defaultColumns: ["occurred_at", "actor", "action", "entity_type", "entity_id"],
  async load(ctx, filters, limit) {
    const { from, to } = filters.period as { from: string; to: string }
    const { rows } = await ctx.client.query(`SELECT to_char(a.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS occurred_at,
        (a.occurred_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS occurred_on,
        coalesce(i.display_name, i.email, 'Sistema') AS actor, a.action, a.entity_type, a.entity_id
      FROM audit_log a LEFT JOIN identities i ON i.id=a.identity_id
      WHERE a.tenant_id=$1
        AND a.occurred_at >= ($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
        AND a.occurred_at < (($3::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
        AND ($4::text IS NULL OR a.action ILIKE $4)
        AND ($5::text IS NULL OR a.entity_type ILIKE $5)
        AND ($6::text IS NULL OR coalesce(i.display_name, i.email, 'Sistema') ILIKE $6)
      ORDER BY a.occurred_at DESC, a.id LIMIT $7`,
      [ctx.tenantId, from, to, like(filters.action), like(filters.entity_type), like(filters.actor), limit])
    return rows as never
  },
})
