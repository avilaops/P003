# PR 04 • Porte para TypeScript: plataforma e sistema

## Objetivo

Portar as rotas de sistema, plataforma, auditoria, permissões, assistente, histórico legado, integrações, webhooks, assinatura da conta e `service_auth`.

## Escopo

### Rotas a portar (33)

| Método | Caminho | Handler Rust |
| --- | --- | --- |
| GET | `/api/health` | `health::api_health` |
| POST | `/api/v1/assistant` | `axum::routing::post`, `crate::domains::assistant::chat` |
| GET | `/api/v1/audit` | `crate::platform::audit::list` |
| GET | `/api/v1/company-account` | `apps/api/src/platform/subscriptions/mod.rs:70` |
| POST | `/api/v1/company-account/cancel` | `apps/api/src/platform/subscriptions/mod.rs:74` |
| POST | `/api/v1/company-account/change-plan` | `apps/api/src/platform/subscriptions/mod.rs:73` |
| POST | `/api/v1/company-account/checkout` | `apps/api/src/platform/subscriptions/mod.rs:71` |
| GET | `/api/v1/company-account/invoices` | `apps/api/src/platform/subscriptions/mod.rs:75` |
| POST | `/api/v1/company-account/refresh` | `apps/api/src/platform/subscriptions/mod.rs:72` |
| GET | `/api/v1/integrations/service-keys` | `apps/api/src/platform/service_auth.rs:66` |
| POST | `/api/v1/integrations/service-keys` | `apps/api/src/platform/service_auth.rs:66` |
| DELETE | `/api/v1/integrations/service-keys/{id}` | `apps/api/src/platform/service_auth.rs:67` |
| GET | `/api/v1/legacy-history` | `crate::domains::legacy::list` |
| GET | `/api/v1/legacy-history/files/{id}` | `crate::domains::legacy::file` |
| GET | `/api/v1/permissions` | `access::list_permissions` |
| GET | `/api/v1/platform/mail-settings` | `crate::platform::mail_settings::get`, `crate::platform::mail_settings::put` |
| PUT | `/api/v1/platform/mail-settings` | `crate::platform::mail_settings::get`, `crate::platform::mail_settings::put` |
| GET | `/api/v1/system/custom-fields` | `crate::platform::custom_fields::create`, `crate::platform::custom_fields::list` |
| POST | `/api/v1/system/custom-fields` | `crate::platform::custom_fields::create`, `crate::platform::custom_fields::list` |
| PUT | `/api/v1/system/custom-fields/{id}` | `axum::routing::put`, `crate::platform::custom_fields::update` |
| GET | `/api/v1/system/files` | `crate::platform::files::list` |
| POST | `/api/v1/system/files/{id}/archive` | `crate::platform::files::archive` |
| GET | `/api/v1/system/files/{id}/content` | `crate::platform::files::content` |
| GET | `/api/v1/system/label-templates` | `crate::platform::label_templates::create`, `crate::platform::label_templates::list` |
| POST | `/api/v1/system/label-templates` | `crate::platform::label_templates::create`, `crate::platform::label_templates::list` |
| PUT | `/api/v1/system/label-templates/{id}` | `axum::routing::put`, `crate::platform::label_templates::update` |
| GET | `/api/v1/system/workflows` | `crate::platform::workflows::create`, `crate::platform::workflows::list` |
| POST | `/api/v1/system/workflows` | `crate::platform::workflows::create`, `crate::platform::workflows::list` |
| PUT | `/api/v1/system/workflows/{id}` | `axum::routing::put`, `crate::platform::workflows::update` |
| POST | `/api/v1/system/workflows/{id}/archive` | `crate::platform::workflows::archive` |
| POST | `/api/v1/system/workflows/{id}/publish` | `crate::platform::workflows::publish` |
| POST | `/api/v1/webhooks/contracts/{tenant}` | `axum::routing::post`, `crate::domains::contracts::webhook` |
| GET | `/openapi.json` | `openapi::document` |

### Arquivos Rust de origem

- `apps/api/src/domains/assistant/mod.rs`
- `apps/api/src/domains/contracts/mod.rs`
- `apps/api/src/domains/legacy.rs`
- `apps/api/src/platform/audit.rs`
- `apps/api/src/platform/custom_fields.rs`
- `apps/api/src/platform/files.rs`
- `apps/api/src/platform/label_templates.rs`
- `apps/api/src/platform/mail_settings.rs`
- `apps/api/src/platform/service_auth.rs`
- `apps/api/src/platform/subscriptions/mod.rs`
- `apps/api/src/platform/workflows.rs`

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

