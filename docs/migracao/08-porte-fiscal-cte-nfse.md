# PR 08 • Porte para TypeScript: fiscal (CT-e, NFS-e recebida, Lojas)

## Objetivo

Portar distribuição, vínculos e inspeção de CT-e, NFS-e recebida e Lojas. É a parte de maior risco: assinatura de XML, certificados e SEFAZ. Antes de portar, avaliar se o `apps/fiscal-engine` (TypeScript) já cobre o que falta.

## Escopo

### Rotas a portar (18)

| Método | Caminho | Handler Rust |
| --- | --- | --- |
| GET | `/api/v1/fiscal/cte-distribution/documents` | `apps/api/src/domains/fiscal/cte_distribution.rs:36` |
| GET | `/api/v1/fiscal/cte-distribution/documents/{id}` | `apps/api/src/domains/fiscal/cte_distribution.rs:37` |
| GET | `/api/v1/fiscal/cte-distribution/documents/{id}/commercial-links` | `apps/api/src/domains/fiscal/cte_links.rs:36` |
| POST | `/api/v1/fiscal/cte-distribution/documents/{id}/commercial-links` | `apps/api/src/domains/fiscal/cte_links.rs:36` |
| POST | `/api/v1/fiscal/cte-distribution/documents/{id}/commercial-links/{linkId}/unlink` | `apps/api/src/domains/fiscal/cte_links.rs:44` |
| GET | `/api/v1/fiscal/cte-distribution/documents/{id}/commercial-options` | `apps/api/src/domains/fiscal/cte_links.rs:40` |
| POST | `/api/v1/fiscal/cte-distribution/documents/{id}/inspect` | `apps/api/src/domains/fiscal/cte_inspection.rs:55` |
| GET | `/api/v1/fiscal/cte-distribution/documents/{id}/inspection` | `apps/api/src/domains/fiscal/cte_inspection.rs:51` |
| POST | `/api/v1/fiscal/cte-distribution/query` | `apps/api/src/domains/fiscal/cte_distribution.rs:35` |
| GET | `/api/v1/fiscal/cte-distribution/runs/{id}` | `apps/api/src/domains/fiscal/cte_distribution.rs:41` |
| GET | `/api/v1/fiscal/cte-distribution/status` | `apps/api/src/domains/fiscal/cte_distribution.rs:34` |
| GET | `/api/v1/fiscal/received-nfses` | `apps/api/src/domains/fiscal/received_nfse.rs:38` |
| POST | `/api/v1/fiscal/received-nfses/import` | `apps/api/src/domains/fiscal/received_nfse.rs:39` |
| GET | `/api/v1/fiscal/received-nfses/{id}` | `apps/api/src/domains/fiscal/received_nfse.rs:40` |
| GET | `/api/v1/fiscal/received-nfses/{id}/xml` | `apps/api/src/domains/fiscal/received_nfse.rs:41` |
| GET | `/api/v1/notas-recebidas` | `apps/api/src/domains/fiscal/lojas.rs:22` |
| GET | `/api/v1/notas-recebidas/{id}/danfe` | `apps/api/src/domains/fiscal/lojas.rs:24` |
| GET | `/api/v1/notas-recebidas/{id}/xml` | `apps/api/src/domains/fiscal/lojas.rs:23` |

### Arquivos Rust de origem

- `apps/api/src/domains/fiscal/cte_distribution.rs`
- `apps/api/src/domains/fiscal/cte_inspection.rs`
- `apps/api/src/domains/fiscal/cte_links.rs`
- `apps/api/src/domains/fiscal/lojas.rs`
- `apps/api/src/domains/fiscal/received_nfse.rs`

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

