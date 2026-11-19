# Como escrever um teste de rota (api-ts)

Toda rota registrada em `apps/api-ts` precisa de **um teste de sucesso** e **um de acesso negado**. O padrão é único: helper de fixture, título com marcador e contrato OpenAPI regenerado.

## 1. Teste com o helper

```ts
import assert from "node:assert/strict"
import test from "node:test"
import { databaseTestOptions, withTestContext } from "./support/test-context.js"

test("GET /api/v1/parties [sucesso] lista as pessoas da empresa", databaseTestOptions, async () => {
  await withTestContext({ permissions: ["catalog.parties.read"] }, async ctx => {
    const response = await ctx.as("user").get("/api/v1/parties")
    assert.equal(response.statusCode, 200, response.body)
  })
})

test("GET /api/v1/parties [negado] sem permissão, sem token e de outra empresa", databaseTestOptions, async () => {
  await withTestContext({}, async ctx => {
    assert.equal((await ctx.as("user").get("/api/v1/parties")).statusCode, 403)      // papel sem a permissão
    assert.equal((await ctx.as("denied").get("/api/v1/parties")).statusCode, 403)    // membro sem permissão alguma
    assert.equal((await ctx.as("anonymous").get("/api/v1/parties")).statusCode, 401) // sem token
    await ctx.grant("user", "catalog.parties.read")
    assert.equal((await ctx.as("user").get("/api/v1/parties", { tenant: ctx.otherTenant })).statusCode, 403) // outra empresa
  })
})
```

`createTestContext` / `withTestContext` (`apps/api-ts/test/support/test-context.ts`) criam um banco PostgreSQL descartável com as migrações, **duas empresas** e quatro personas, e o apagam no fim (sem estado entre testes):

| Persona | O que é |
| --- | --- |
| `user` | membro da empresa A com as `permissions` pedidas (`ctx.grant("user", ...)` concede mais depois) |
| `denied` | membro da empresa A sem nenhuma permissão |
| `outsider` | membro só da empresa B, com todas as permissões (prova isolamento por empresa) |
| `anonymous` | sem token |

Cliente: `ctx.as(persona).get|post|put|patch|delete(url, { body, query, headers, revision, idempotencyKey, tenant })`. Escritas recebem `Idempotency-Key` automática (passe `idempotencyKey` para repetir a mesma intenção); `revision: 3` envia `If-Match: "3"`. Para semear dados use `ctx.seed` (conexão administrativa); o app roda com o papel `NOSUPERUSER NOBYPASSRLS`, como em produção. Outras dependências entram em `{ dependencies: { ... } }`.

Os testes de banco rodam com `API_TS_TEST_ADMIN_URL=postgres://usuario@127.0.0.1:5432/postgres` (PostgreSQL **local e descartável**); sem a variável eles são pulados.

## 2. Título com marcador

O título declara o que o teste cobre: `METHOD /caminho [sucesso]` ou `[negado]`. Parâmetros: `{id}` ou `:id`. Várias rotas: `GET /a + POST /a [negado] ...`. É o que o teste de cobertura lê (`test/route-coverage.test.ts`).

- Ver a lacuna: `pnpm --filter api-ts route-coverage` (ou o diagnóstico de `pnpm --filter api-ts test`).
- Hoje o teste **só reporta**. Para falhar quando faltar cobertura: `ROUTE_COVERAGE_ENFORCE=1` (ou troque o padrão em `route-coverage.test.ts` quando a lacuna for zero).

## 3. Contrato OpenAPI

O contrato `apps/api-ts/openapi.json` é gerado das rotas registradas e é a fonte de verdade. Ao criar ou portar uma rota:

```bash
pnpm --filter api-ts openapi
```

e inclua o arquivo no commit. O teste `test/openapi.test.ts` e o CI (`openapi:check`) falham se ele divergir. Para documentar os schemas zod da rota:

```ts
app.put("/api/v1/x", { config: { openapi: { summary: "…", body: xInputSchema } } }, handler)
```

`buildOpenApiDocument(app)` (`src/platform/openapi.ts`) é a função que a rota `/openapi.json` deve servir.

## 4. O que falta portar

`verification/ts-migration-baseline.json` guarda as operações do backend anterior. `pnpm --filter api-ts exec tsx ../../verification/ts-migration-inventory.mjs --summary` mostra `native_only`: quantas ainda não têm rota no Fastify. O CI exibe esse número no resumo do job; cada PR de porte deve reduzi-lo. Também é preciso manter `verification/contracts.json` (ficha de ação por operação) — `pnpm test:verification` aponta o que falta.

Raiz do repositório: `pnpm test` roda typecheck e testes do api-ts, `verification/` e `architecture`, sem ler arquivos `.rs`.
