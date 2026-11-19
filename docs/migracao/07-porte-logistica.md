# PR 07 • Porte para TypeScript: logística

## Objetivo

Portar checkout, despacho e as demais rotas de logística.

## Escopo

### Rotas a portar (15)

| Método | Caminho | Handler Rust |
| --- | --- | --- |
| GET | `/api/v1/logistics/checkouts` | `apps/api/src/domains/logistics_checkout.rs:51` |
| POST | `/api/v1/logistics/checkouts` | `apps/api/src/domains/logistics_checkout.rs:51` |
| GET | `/api/v1/logistics/checkouts/{id}` | `apps/api/src/domains/logistics_checkout.rs:52` |
| POST | `/api/v1/logistics/checkouts/{id}/complete` | `apps/api/src/domains/logistics_checkout.rs:65` |
| GET | `/api/v1/logistics/checkouts/{id}/labels` | `apps/api/src/domains/logistics_dispatch.rs:29` |
| POST | `/api/v1/logistics/checkouts/{id}/labels` | `apps/api/src/domains/logistics_dispatch.rs:29` |
| POST | `/api/v1/logistics/checkouts/{id}/lines/{line}/check` | `apps/api/src/domains/logistics_checkout.rs:53` |
| POST | `/api/v1/logistics/checkouts/{id}/packages` | `apps/api/src/domains/logistics_checkout.rs:57` |
| POST | `/api/v1/logistics/checkouts/{id}/packages/{package_id}/status` | `apps/api/src/domains/logistics_checkout.rs:61` |
| GET | `/api/v1/logistics/labels` | `apps/api/src/domains/logistics_dispatch.rs:28` |
| GET | `/api/v1/logistics/postings` | `apps/api/src/domains/logistics.rs:77` |
| POST | `/api/v1/logistics/postings` | `apps/api/src/domains/logistics.rs:77` |
| GET | `/api/v1/logistics/postings/{id}` | `apps/api/src/domains/logistics.rs:78` |
| POST | `/api/v1/logistics/postings/{id}/packages` | `apps/api/src/domains/logistics_dispatch.rs:33` |
| POST | `/api/v1/logistics/postings/{id}/status` | `apps/api/src/domains/logistics.rs:79` |

### Arquivos Rust de origem

- `apps/api/src/domains/logistics.rs`
- `apps/api/src/domains/logistics_checkout.rs`
- `apps/api/src/domains/logistics_dispatch.rs`

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

