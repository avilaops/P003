# PR 06 • Porte para TypeScript: comercial

## Objetivo

Portar propostas, simulador de vendas, publicação de catálogo e as configurações de venda e de compra.

## Escopo

### Rotas a portar (12)

| Método | Caminho | Handler Rust |
| --- | --- | --- |
| GET | `/api/v1/catalog-publication` | `crate::domains::catalog_publication::preview`, `crate::domains::catalog_publication::publish` |
| POST | `/api/v1/catalog-publication` | `crate::domains::catalog_publication::preview`, `crate::domains::catalog_publication::publish` |
| POST | `/api/v1/proposals/{id}/approve-order` | `axum::routing::post`, `sales::proposals::approve_order` |
| POST | `/api/v1/proposals/{id}/convert` | `axum::routing::post`, `sales::proposals::convert` |
| POST | `/api/v1/proposals/{id}/revise` | `axum::routing::post`, `sales::proposals::revise` |
| GET | `/api/v1/purchase-settings` | `crate::domains::supply_settings::get_purchase`, `crate::domains::supply_settings::put_purchase` |
| PUT | `/api/v1/purchase-settings` | `crate::domains::supply_settings::get_purchase`, `crate::domains::supply_settings::put_purchase` |
| GET | `/api/v1/sales-settings` | `sales::settings::get`, `sales::settings::put` |
| PUT | `/api/v1/sales-settings` | `sales::settings::get`, `sales::settings::put` |
| GET | `/api/v1/sales-simulator/{line}` | `crate::domains::sales::pricing::options` |
| POST | `/api/v1/sales-simulator/{line}/orders` | `crate::domains::sales::pricing_orders::create` |
| POST | `/api/v1/sales-simulator/{line}/quote` | `crate::domains::sales::pricing::quote` |

### Arquivos Rust de origem

- `apps/api/src/domains/catalog_publication.rs`
- `apps/api/src/domains/sales/pricing.rs`
- `apps/api/src/domains/sales/pricing_orders.rs`
- `apps/api/src/domains/sales/proposals.rs`
- `apps/api/src/domains/sales/settings.rs`
- `apps/api/src/domains/supply_settings.rs`

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

