import type { DatabaseClient } from "../../platform/database.js"
import { invalid } from "../../platform/domain.js"

/**
 * Catálogo único de parâmetros (G5). As definições nascem por migração em
 * `parameter_definitions`; o valor por empresa fica em `parameter_values`.
 * Outros módulos leem parâmetros só por `readParameter`/`readParameters`.
 */
export type ParameterType = "boolean" | "integer" | "decimal" | "text" | "choice"
export type ParameterValue = boolean | number | string

export type ParameterRow = {
  code: string; module: string; label: string; description: string; value_type: ParameterType
  default_value: ParameterValue; choices: string[]; minimum: string | null; maximum: string | null; unit: string | null
  value: ParameterValue | null; revision: string | number | null; updated_by: string | null; updated_by_name: string | null; updated_at: string | null
}

export const parameterSelect = `SELECT d.code,d.module,d.label,d.description,d.value_type,d.default_value,d.choices,
  d.minimum::text minimum,d.maximum::text maximum,d.unit,v.value,v.revision,v.updated_by,
  coalesce(i.display_name,i.email) updated_by_name,
  to_char(v.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') updated_at
  FROM parameter_definitions d
  LEFT JOIN parameter_values v ON v.code=d.code AND v.tenant_id=$1
  LEFT JOIN identities i ON i.auth_subject=v.updated_by`

export function presentParameter(row: ParameterRow) {
  const customized = row.value !== null && row.value !== undefined
  return {
    code: row.code, module: row.module, label: row.label, description: row.description, type: row.value_type,
    defaultValue: row.default_value, value: customized ? row.value : row.default_value, customized,
    choices: row.choices, minimum: row.minimum === null ? null : Number(row.minimum), maximum: row.maximum === null ? null : Number(row.maximum), unit: row.unit,
    // Sem valor próprio a revisão é 1; o primeiro ajuste grava a revisão 2.
    revision: row.revision === null ? 1 : Number(row.revision),
    updatedBy: row.updated_by_name ?? row.updated_by, updatedAt: row.updated_at,
  }
}

/** Valida o valor contra a definição; lança 422 com mensagem legível. */
export function validateParameterValue(row: Pick<ParameterRow, "value_type" | "choices" | "minimum" | "maximum" | "label">, value: unknown): ParameterValue {
  const range = (n: number) => {
    if (row.minimum !== null && n < Number(row.minimum) || row.maximum !== null && n > Number(row.maximum))
      throw invalid(`${row.label}: informe um valor entre ${row.minimum ?? "-∞"} e ${row.maximum ?? "∞"}`)
    return n
  }
  switch (row.value_type) {
    case "boolean": if (typeof value === "boolean") return value; break
    case "integer": if (typeof value === "number" && Number.isSafeInteger(value)) return range(value); break
    case "decimal": if (typeof value === "number" && Number.isFinite(value)) return range(value); break
    case "text": if (typeof value === "string" && value.trim().length >= 1 && value.length <= 500 && !/[\u0000-\u001f\u007f]/.test(value)) return value.trim(); break
    case "choice": if (typeof value === "string" && row.choices.includes(value)) return value; break
  }
  throw invalid(`${row.label}: valor incompatível com o tipo do parâmetro`)
}

/** Valor efetivo de um parâmetro para a empresa da transação (padrão quando não ajustado). */
export async function readParameter<T extends ParameterValue>(client: DatabaseClient, tenantId: string, code: string): Promise<T> {
  const row = (await client.query<ParameterRow>(`${parameterSelect} WHERE d.code=$2`, [tenantId, code])).rows[0]
  if (!row) throw new Error(`Parâmetro não registrado no catálogo: ${code}`)
  return presentParameter(row).value as T
}

export async function readParameters(client: DatabaseClient, tenantId: string, codes: string[]) {
  const rows = (await client.query<ParameterRow>(`${parameterSelect} WHERE d.code=ANY($2::text[])`, [tenantId, codes])).rows
  const values = new Map(rows.map(row => [row.code, presentParameter(row).value]))
  for (const code of codes) if (!values.has(code)) throw new Error(`Parâmetro não registrado no catálogo: ${code}`)
  return values
}
