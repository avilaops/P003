# PR 05 • Porte para TypeScript: cadastros e acesso

## Objetivo

Portar produtos, funcionários, listas de preço, papéis, convites, usuários, empresas, cadastro e seleção de empresa e consulta de registro.

## Escopo

### Rotas a portar (34)

| Método | Caminho | Handler Rust |
| --- | --- | --- |
| GET | `/api/v1/companies` | `onboarding::create`, `onboarding::list` |
| POST | `/api/v1/companies` | `onboarding::create`, `onboarding::list` |
| GET | `/api/v1/company` | `company::get_company`, `company::put_company` |
| PUT | `/api/v1/company` | `company::get_company`, `company::put_company` |
| POST | `/api/v1/company-registration/lookup` | `crate::domains::registry_lookup::lookup_registration` |
| POST | `/api/v1/company-selection` | `onboarding::select_company` |
| GET | `/api/v1/invitations` | `invitations::create`, `invitations::list` |
| POST | `/api/v1/invitations` | `invitations::create`, `invitations::list` |
| POST | `/api/v1/invitations/{id}/resend` | `axum::routing::post`, `invitations::resend` |
| POST | `/api/v1/invitations/{id}/revoke` | `axum::routing::post`, `invitations::revoke` |
| GET | `/api/v1/price-lists` | `price_lists::create`, `price_lists::list` |
| POST | `/api/v1/price-lists` | `price_lists::create`, `price_lists::list` |
| GET | `/api/v1/price-lists/{id}` | `price_lists::get`, `price_lists::update` |
| PUT | `/api/v1/price-lists/{id}` | `price_lists::get`, `price_lists::update` |
| GET | `/api/v1/products/export` | `data_transfer::export` |
| POST | `/api/v1/products/import` | `axum::routing::post`, `data_transfer::preview` |
| GET | `/api/v1/products/import/{id}` | `data_transfer::get_import` |
| POST | `/api/v1/products/import/{id}/confirm` | `axum::routing::post`, `data_transfer::confirm` |
| GET | `/api/v1/products/{id}/catalog` | `axum::extract`, `crate::domains::catalog_publication::get`, `crate::domains::catalog_publication::put` |
| PUT | `/api/v1/products/{id}/catalog` | `axum::extract`, `crate::domains::catalog_publication::get`, `crate::domains::catalog_publication::put` |
| GET | `/api/v1/products/{id}/media/{media_id}` | `crate::domains::catalog_publication::media` |
| POST | `/api/v1/registry-lookups` | `axum::routing::post`, `crate::domains::registry_lookup::lookup` |
| GET | `/api/v1/roles` | `access::list_roles`, `access_management::create_role` |
| POST | `/api/v1/roles` | `access::list_roles`, `access_management::create_role` |
| DELETE | `/api/v1/roles/{id}` | `access_management::delete_role`, `access_management::get_role`, `access_management::update_role` |
| GET | `/api/v1/roles/{id}` | `access_management::delete_role`, `access_management::get_role`, `access_management::update_role` |
| PUT | `/api/v1/roles/{id}` | `access_management::delete_role`, `access_management::get_role`, `access_management::update_role` |
| GET | `/api/v1/staff` | `staff::create`, `staff::list` |
| POST | `/api/v1/staff` | `staff::create`, `staff::list` |
| GET | `/api/v1/staff/{id}` | `staff::get`, `staff::update` |
| PUT | `/api/v1/staff/{id}` | `staff::get`, `staff::update` |
| GET | `/api/v1/users` | `access::list_users` |
| GET | `/api/v1/users/{id}` | `access_management::get_member`, `access_management::update_member` |
| PUT | `/api/v1/users/{id}` | `access_management::get_member`, `access_management::update_member` |

### Arquivos Rust de origem

- `apps/api/src/domains/catalog_publication.rs`
- `apps/api/src/domains/registry_lookup/mod.rs`

## Como fazer (todo PR de porte)
1. Para cada rota da lista, ler o handler Rust indicado e reproduzir **método, caminho, permissões exigidas, validações, cabeçalhos (`If-Match`, `Idempotency-Key`), códigos de status e formato do corpo**.
2. Implementar em `apps/api-ts/src/modules/<domínio>/`, no padrão dos módulos existentes (zod para entrada, `authorizeRequest` e `requirePermission`, isolamento por empresa), e registrar em `apps/api-ts/src/app.ts`.
3. Escrever **testes novos** em `apps/api-ts/test/` (PostgreSQL de teste, no estilo de `postgres-sales.test.ts`). Cobrir sucesso, 401/403, validação 422, conflito 409/412 e idempotência quando existir. Os testes atuais não estão completos e não devem ser a única referência.
4. Não apagar nada em `apps/api` (Rust). A remoção é do último PR.
5. Rodar `pnpm --filter api-ts typecheck` e `pnpm --filter api-ts test` antes de pedir revisão.

## Critérios de aceite
- Todas as rotas da lista respondem pelo `api-ts` com o mesmo contrato do Rust, ou com divergência **documentada** na descrição do PR.
- Testes novos cobrindo cada rota (caminho feliz, sem permissão, entrada inválida e conflito).
- Typecheck e testes do `api-ts` verdes no CI.
- Rotas registradas em `apps/api-ts/src/modules/*-endpoints.json` ou equivalente, se o inventário do repositório exigir.

## Observações
- O sistema ainda não está em produção: não é preciso manter compatibilidade nem rodar em paralelo com o Rust.
- Conflitos esperados com os outros PRs de porte: só a linha de registro em `app.ts`. Resolver mantendo as duas linhas.
- Contagem e origem das rotas vêm de `verification/ts-migration-inventory.mjs` (status `native_only`).

