# PR 10 • Porte para TypeScript: ferramentas do MCP

## Objetivo

Portar as 15 operações do MCP (`apps/api/src/mcp`), mantendo OAuth, escopos e o formato das ferramentas.

## Escopo

### Rotas a portar (15)

| Método | Caminho | Handler Rust |
| --- | --- | --- |
| GET | `/.well-known/oauth-authorization-server` | `apps/api/src/mcp/mod.rs:95` |
| GET | `/.well-known/oauth-protected-resource` | `apps/api/src/mcp/mod.rs:87` |
| GET | `/.well-known/oauth-protected-resource/mcp` | `apps/api/src/mcp/mod.rs:91` |
| DELETE | `/mcp` | `apps/api/src/mcp/mod.rs:80` |
| GET | `/mcp` | `apps/api/src/mcp/mod.rs:80` |
| OPTIONS | `/mcp` | `apps/api/src/mcp/mod.rs:80` |
| POST | `/mcp` | `apps/api/src/mcp/mod.rs:80` |
| GET | `/mcp/oauth/authorization-request` | `apps/api/src/mcp/mod.rs:105` |
| POST | `/mcp/oauth/grant` | `apps/api/src/mcp/mod.rs:77` |
| OPTIONS | `/mcp/oauth/register` | `apps/api/src/mcp/mod.rs:99` |
| POST | `/mcp/oauth/register` | `apps/api/src/mcp/mod.rs:99` |
| OPTIONS | `/mcp/oauth/revoke` | `apps/api/src/mcp/mod.rs:115` |
| POST | `/mcp/oauth/revoke` | `apps/api/src/mcp/mod.rs:115` |
| OPTIONS | `/mcp/oauth/token` | `apps/api/src/mcp/mod.rs:109` |
| POST | `/mcp/oauth/token` | `apps/api/src/mcp/mod.rs:109` |

### Arquivos Rust de origem

- `apps/api/src/mcp/mod.rs`

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


## Entrega (api-ts)

Código: `apps/api-ts/src/modules/mcp/` (`oauth.ts`, `catalog.ts`, `routes.ts`), registrado em `app.ts`.
Testes: `apps/api-ts/test/mcp-oauth.test.ts` (PostgreSQL): registro → autorização → grant → token → `/mcp` com escopo certo (200) e errado (403) → revogação, rotação e reuso de refresh token, isolamento por empresa.

O catálogo de ferramentas deriva do OpenAPI do próprio api-ts (como o Rust derivava do seu). Os nomes de ferramenta são os mesmos (326 no Rust; 263 já existem no TS com nome idêntico; as 63 restantes são rotas ainda `native_only` de outros PRs e aparecem sozinhas quando forem portadas).

### Divergências em relação ao Rust

| Rota | Rust | TypeScript | Motivo |
| --- | --- | --- | --- |
| `POST /mcp` `tools/call` | `inject` sem `await` dentro do contexto de identidade (no despacho interno do `api-ts`) | `await app.inject` dentro de `runWithMcpIdentity` (também em `platform/mcp-dispatch.ts` e `inventory/mcp.ts`) | `inject` do light-my-request é preguiçoso: com o servidor escutando, a rota interna perdia a identidade do MCP e respondia 401 |
| `POST /mcp/oauth/register` | URI de redirecionamento com `#` vazio aceita (a URL normalizada some com o fragmento) | rejeitada | RFC 6749 §3.1.2 proíbe fragmento |
| `POST /mcp/oauth/token`, `/revoke` | parâmetro de formulário repetido: vale o primeiro | `400 invalid_request`; mídia diferente de `application/x-www-form-urlencoded` → `415` | RFC 6749 §3.2 |
| `POST /mcp/oauth/revoke` | token ausente: `400 invalid_grant` | `400 invalid_request` | RFC 7009 |
| `GET /mcp/oauth/authorization-request` | parâmetro repetido: erro de deserialização | `400 invalid_request` | ambiguidade |
| Ferramentas de escrita | cabeçalhos livres por operação do OpenAPI | `headers` aceita só `If-Match` e `Idempotency-Key` | o contrato TS não declara cabeçalhos; a rota decide se são obrigatórios |
| Ferramentas GET sem filtros declarados | sem `query` | `query` aberta (valores escalares) | rotas TS validam o próprio `query` com zod |

Fora do escopo/adiado: `OPTIONS` não entra no relatório de cobertura (`route-coverage` só reconhece GET/POST/PUT/PATCH/DELETE; testados mesmo assim). A tela de consentimento (`apps/web`) continua falando com `/mcp/oauth/*` por HTTP e não muda.
