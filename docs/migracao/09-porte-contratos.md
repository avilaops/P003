# PR 09 • Porte para TypeScript: contratos e modelos

## Objetivo

Portar contratos comerciais e modelos de contrato. O validador ICP já é um serviço privado separado: só a borda HTTP migra.

## Escopo

### Rotas a portar (15)

| Método | Caminho | Handler Rust |
| --- | --- | --- |
| GET | `/api/v1/commercial-contracts` | `apps/api/src/domains/contracts/mod.rs:39` |
| POST | `/api/v1/commercial-contracts` | `apps/api/src/domains/contracts/mod.rs:39` |
| GET | `/api/v1/commercial-contracts/options/{id}` | `apps/api/src/domains/contracts/mod.rs:40` |
| GET | `/api/v1/commercial-contracts/{id}` | `apps/api/src/domains/contracts/mod.rs:41` |
| GET | `/api/v1/commercial-contracts/{id}/files/{file}` | `apps/api/src/domains/contracts/mod.rs:49` |
| POST | `/api/v1/commercial-contracts/{id}/review` | `apps/api/src/domains/contracts/mod.rs:42` |
| POST | `/api/v1/commercial-contracts/{id}/send` | `apps/api/src/domains/contracts/mod.rs:43` |
| POST | `/api/v1/commercial-contracts/{id}/sync` | `apps/api/src/domains/contracts/mod.rs:48` |
| GET | `/api/v1/contract-template-drafts` | `apps/api/src/domains/contracts/templates.rs:138` |
| GET | `/api/v1/contract-template-drafts/catalog` | `apps/api/src/domains/contracts/templates.rs:139` |
| GET | `/api/v1/contract-template-drafts/{id}` | `apps/api/src/domains/contracts/templates.rs:148` |
| POST | `/api/v1/contract-template-drafts/{id}` | `apps/api/src/domains/contracts/templates.rs:148` |
| POST | `/api/v1/contract-template-drafts/{id}/import` | `apps/api/src/domains/contracts/templates.rs:144` |
| GET | `/api/v1/contract-template-drafts/{id}/pdf` | `apps/api/src/domains/contracts/templates.rs:152` |
| POST | `/api/v1/contract-template-drafts/{id}/publish` | `apps/api/src/domains/contracts/templates.rs:140` |

### Arquivos Rust de origem

- `apps/api/src/domains/contracts/mod.rs`
- `apps/api/src/domains/contracts/templates.rs`

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

