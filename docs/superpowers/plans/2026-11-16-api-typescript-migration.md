# Migração gradual da API para TypeScript • Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrar Preferências, Cadastros, Vendas e Relatórios para uma API TypeScript separada sem alterar contratos do ERP.

**Architecture:** `apps/api-ts` replica contratos módulo a módulo usando Fastify, `pg` e Zod. O BFF seleciona o backend por rota, sem retry de comandos, e mantém Rust somente para recursos ainda não migrados.

**Tech Stack:** Node.js • TypeScript • Fastify • PostgreSQL `pg` • Zod • node:test • pnpm

**Spec:** `docs/superpowers/specs/2026-11-16-api-typescript-migration-design.md`

## Global Constraints

• PostgreSQL próprio, Auth e migrations existentes permanecem.

• Toda consulta de negócio executa em transação com `app.tenant_id`.

• Contratos HTTP, JSON, ETag, revisão, auditoria e idempotência não mudam.

• Nenhum comando é repetido automaticamente entre backends.

• Textos usam `•` como separador quando a sintaxe técnica não exigir outro caractere.

## Review Focus

• Token ausente, inválido ou Auth indisponível deve manter 401/503 sem consultar negócio • Task 1.

• Empresa ausente, inválida ou sem vínculo deve manter 400/403 • Task 1.

• Uma conexão devolvida ao pool não pode conservar `app.tenant_id` • Task 1.

• Escrita com revisão desatualizada não pode alterar dados • Tasks 2 a 5.

• Falha do backend TypeScript nunca pode reenviar POST ou PUT ao Rust • Task 6.

---

### Task 1: Fundação da API TypeScript

**Files:**
- Create: `apps/api-ts/package.json`
- Create: `apps/api-ts/tsconfig.json`
- Create: `apps/api-ts/src/app.ts`
- Create: `apps/api-ts/src/server.ts`
- Create: `apps/api-ts/src/platform/config.ts`
- Create: `apps/api-ts/src/platform/auth.ts`
- Create: `apps/api-ts/src/platform/access.ts`
- Create: `apps/api-ts/src/platform/database.ts`
- Create: `apps/api-ts/src/platform/problem.ts`
- Create: `apps/api-ts/test/platform.test.ts`

**Interfaces:**
- Produces: `buildApp(dependencies) -> FastifyInstance`
- Produces: `withTenantTransaction(context, callback)`
- Produces: identidade autenticada e conjunto de permissões por requisição

- [x] Escrever testes falhos para autenticação, empresa, permissão, rollback e limpeza do contexto RLS.
- [x] Implementar a fundação mínima e `/health/live`.
- [x] Executar `pnpm --filter api-ts test` e confirmar PASS.
- [x] Commit `feat(api-ts): add tenant-safe TypeScript foundation`.

### Task 2: Preferências

**Files:**
- Create: `apps/api-ts/src/modules/preferences/routes.ts`
- Create: `apps/api-ts/src/modules/preferences/service.ts`
- Create: `apps/api-ts/src/modules/preferences/schema.ts`
- Create: `apps/api-ts/test/preferences.test.ts`

**Interfaces:**
- Produces: `GET /api/v1/preferences`
- Produces: `PUT /api/v1/preferences`

- [x] Escrever testes de contrato falhos para defaults, owner key, validação, ETag, 409, 412 e auditoria.
- [x] Implementar leitura e escrita compatíveis com Rust.
- [x] Executar testes TypeScript e contratos de Preferências.
- [x] Commit `feat(api-ts): migrate preferences`.

### Task 3: Cadastros

**Files:**
- Create: `apps/api-ts/src/modules/parties/*`
- Create: `apps/api-ts/src/modules/products/*`
- Create: `apps/api-ts/src/modules/reference-data/*`
- Create: `apps/api-ts/test/registrations.test.ts`

**Interfaces:**
- Produces: contratos de `parties`, `products`, categorias, grupos, etiquetas e configurações cadastrais usadas pelas telas.

- [x] Escrever matriz de contrato falha para lista, detalhe, criação, atualização, filtros, paginação e isolamento.
- [x] Migrar queries e comandos sem alterar JSON ou códigos HTTP.
- [x] Executar testes TypeScript e contratos de Cadastros.
- [x] Commit `feat(api-ts): migrate registrations`.

### Task 4: Vendas

**Files:**
- Create: `apps/api-ts/src/modules/orders/*`
- Create: `apps/api-ts/src/modules/proposals/*`
- Create: `apps/api-ts/src/modules/commercial/*`
- Create: `apps/api-ts/test/sales.test.ts`

**Interfaces:**
- Produces: listas, detalhes e comandos de pedidos e propostas usados pelas telas de Vendas.

- [x] Escrever matriz de contrato falha para contagens, ordenação, CRUD, revisões, idempotência e transições.
- [x] Migrar consultas e comandos preservando auditoria e outbox.
- [x] Executar testes TypeScript e contratos de Vendas.
- [x] Commit `feat(api-ts): migrate sales`.

### Task 5: Relatórios

**Files:**
- Create: `apps/api-ts/src/modules/dashboard/*`
- Create: `apps/api-ts/src/modules/reports/*`
- Create: `apps/api-ts/test/reports.test.ts`

**Interfaces:**
- Produces: `GET /api/v1/dashboard`
- Produces: CRUD de `/api/v1/system/custom-reports`

- [x] Escrever testes falhos para períodos, permissões, datasets permitidos, revisão e isolamento.
- [x] Migrar painel e relatórios personalizados.
- [x] Executar testes TypeScript e contratos de Relatórios.
- [x] Commit `feat(api-ts): migrate reports`.

### Task 6: Roteamento gradual no BFF

**Files:**
- Create: `apps/web/src/server/bff/erp-backend.ts`
- Modify: `apps/web/src/server/bff/erp-proxy.ts`
- Create: `apps/web/tests/erp-backend-routing.spec.ts`

**Interfaces:**
- Consumes: lista de rotas comprovadamente migradas.
- Produces: escolha determinística entre `ERP_TYPESCRIPT_API_URL` e `ERP_API_URL`.

- [x] Escrever testes falhos de seleção, indisponibilidade e ausência de retry.
- [x] Implementar roteamento explícito e ativação por variável.
- [x] Executar testes web e contratos gerais.
- [x] Commit `feat(web): route migrated modules to TypeScript API`.

### Task 7: Runtime e verificação integrada

**Files:**
- Modify: `deploy/cloudflare/runtime-supervisor.mjs`
- Modify: `deploy/cloudflare/runtime-configuration.mjs`
- Modify: `deploy/cloudflare/runtime-resources.json`
- Modify: `deploy/cloudflare/runtime.Dockerfile`
- Modify: documentação de runtime e contratos.

**Interfaces:**
- Produces: processo `api-ts` privado e configuração de rollback para Rust.

- [x] Escrever testes falhos do supervisor e separação de segredos.
- [x] Adicionar API TypeScript ao runtime sem expor PostgreSQL ao web.
- [x] Executar `pnpm test:cloudflare`, `pnpm test:verification`, testes TypeScript e build web.
- [x] Revisar diff, segurança e documentação.
- [x] Commit `chore(runtime): activate gradual TypeScript API migration`.

## Liberação • evidências

A release `3c00410091fc30e6191f301f2b762740643a2772` foi implantada e os quatro módulos foram ativados gradualmente. A saúde e o retorno operacional por configuração foram conferidos no servidor. As evidências e os limites estão em `docs/architecture/typescript-api-migration-status.md`.

- [x] Conferir as chamadas legadas ainda usadas pelas telas do escopo e registrar a cobertura final.
- [x] Testar o BFF no Next real pelo navegador com os módulos habilitados e o retorno explícito a Rust.
- [x] Integrar o processo privado ao deploy Compose existente, preservando os manifestos e segredos.
- [x] Validar a implantação candidata e ativar gradualmente os módulos.
- [x] Exercitar o retorno por módulo no servidor e restaurar os quatro módulos habilitados.

A retirada das rotas Rust equivalentes é uma próxima onda. Exige observar operações autenticadas no novo caminho e encerrar a janela de retorno; os endpoints continuam disponíveis nesta ativação gradual.
