import type { AccessDependencies, AuthorizedContext } from "./access.js"
import { authorizeRequest, requirePermission } from "./access.js"
import { Problem } from "./problem.js"

type RequestLike = Parameters<typeof authorizeRequest>[0]

// Erros de domínio com o mesmo contrato do `DomainError` do Rust.
export const invalid = (title: string) => new Problem(422, "invalid_input", title)
export const notFound = () => new Problem(404, "not_found", "Registro não encontrado nesta empresa")
export const conflict = (title: string) => new Problem(409, "domain_conflict", title)
export const staleRevision = () => new Problem(412, "revision_conflict", "Outra pessoa alterou o cadastro. Sua edição foi preservada")

/**
 * Equivalente ao `authorized()` do Rust: exige a permissão de leitura sempre e,
 * em escrita, a de gestão. O bloqueio da empresa e a releitura dos direitos
 * acontecem em `authorizeRequest`.
 */
export function authorizedDomain<T>(
  request: RequestLike,
  dependencies: AccessDependencies,
  read: string,
  manage: string,
  write: boolean,
  operation: (context: AuthorizedContext, canEdit: boolean) => Promise<T>,
): Promise<T> {
  return authorizeRequest(request, dependencies, async context => {
    requirePermission(context, read)
    const canEdit = context.permissions.includes(manage)
    if (write && !canEdit) throw new Problem(403, "forbidden", "Acesso não autorizado para esta empresa")
    return operation(context, canEdit)
  }, write)
}
