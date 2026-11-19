import type { LightMyRequestResponse } from "fastify"

import type { AppDependencies } from "../src/app.js"
import { createTestContext, type Persona } from "./support/test-context.js"

/**
 * Adaptador dos testes do PR #285 sobre o helper único `createTestContext` (#284).
 *
 * O banco, as duas empresas, a role sem BYPASSRLS e as identidades vêm do helper.
 * Este arquivo só:
 *  - traduz os papéis usados nos testes de plataforma para as personas do helper:
 *    `admin`→`user`, `visitor`→`denied`, `other`→`outsider`, `null`→`anonymous`;
 *  - `reader` é a persona `denied` com as permissões de leitura concedidas (e,
 *    se pedido, a autoridade de administrador da plataforma), revogadas ao voltar
 *    a `visitor`, para provar 403 sem criar outra identidade;
 *  - concede as permissões de banco que as rotas de plataforma exigem além do
 *    padrão do helper (schema `system_config`, DELETE e funções de RLS);
 *  - permite omitir `x-tenant-id` (`tenant: null`), para rotas globais da plataforma.
 */
export type PlatformToken = "admin" | "reader" | "visitor" | "other" | null
export type PlatformCall = { method: "GET" | "POST" | "PUT" | "DELETE"; url: string; token?: PlatformToken; tenant?: string | null; body?: unknown; headers?: Record<string, string> }
export type PlatformContextOptions = { adminPermissions: string[]; readerPermissions?: string[]; readerIsPlatformAdministrator?: boolean; dependencies?: Partial<AppDependencies> }

/** Assunto (`auth_subject`) real de cada papel de teste. */
export const subjectOf = { admin: "user", reader: "denied", visitor: "denied", other: "outsider" } as const
const persona = { admin: "user", reader: "denied", visitor: "denied", other: "outsider" } as const satisfies Record<string, Persona>

export async function platformContext(options: PlatformContextOptions) {
  const ctx = await createTestContext({ permissions: options.adminPermissions, ...(options.dependencies ? { dependencies: options.dependencies } : {}) })
  try {
    await ctx.seed.query(`GRANT USAGE ON SCHEMA system_config TO ${ctx.role};
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA system_config TO ${ctx.role};
      GRANT DELETE ON ALL TABLES IN SCHEMA public TO ${ctx.role};
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${ctx.role};
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA system_config TO ${ctx.role}`)
    const deniedRole = (await ctx.seed.query("SELECT id FROM roles WHERE tenant_id=$1 AND code='denied'", [ctx.tenant])).rows[0]!.id as string
    let reading = false
    const readerMode = async (on: boolean) => {
      if (reading === on) return
      reading = on
      await ctx.seed.query("DELETE FROM role_permissions WHERE role_id=$1", [deniedRole])
      if (on && options.readerPermissions?.length) await ctx.seed.query("INSERT INTO role_permissions(role_id,permission_code) SELECT $1,unnest($2::text[])", [deniedRole, options.readerPermissions])
      if (options.readerIsPlatformAdministrator) {
        await ctx.seed.query("INSERT INTO platform_administrators(auth_subject,active,granted_by,reason) VALUES('denied',$1,'teste','Administrador da plataforma nos testes') ON CONFLICT (auth_subject) DO UPDATE SET active=$1", [on])
      }
    }
    const call = async ({ method, url, token = "admin", tenant, body, headers = {} }: PlatformCall): Promise<LightMyRequestResponse> => {
      if (token === "reader" || token === "visitor") await readerMode(token === "reader")
      const who: Persona = token === null ? "anonymous" : persona[token]
      if (tenant === null) {
        // Rotas globais: sem `x-tenant-id`.
        return ctx.app.inject({
          method, url,
          headers: { ...(who === "anonymous" ? {} : { authorization: `Bearer ${who}` }), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
          ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
        })
      }
      const client = ctx.as(who)
      const init = { ...(body !== undefined ? { body } : {}), headers, ...(tenant ? { tenant } : {}) }
      return method === "GET" ? client.get(url, init) : method === "POST" ? client.post(url, init) : method === "PUT" ? client.put(url, init) : client.delete(url, init)
    }
    return { ...ctx, call }
  } catch (error) { await ctx.close(); throw error }
}
