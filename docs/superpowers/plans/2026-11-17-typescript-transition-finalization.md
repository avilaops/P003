# API TypeScript • plano de conclusão da transição

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Concluir a transição dos quatro módulos atuais, incluindo MCP e retirada das regras duplicadas da compilação Rust de produção.

**Architecture:** Gateway Rust conserva transporte/contrato e encaminha as operações migradas uma única vez. Fastify mantém o negócio e valida também o despacho privado MCP com os tokens/grants existentes. A implementação antiga é uma referência de compilação explícita para testes.

**Tech Stack:** TypeScript, Fastify, PostgreSQL, Rust/Axum, Next.js, Playwright e Compose existentes.

**Spec:** `docs/superpowers/specs/2026-11-17-typescript-transition-finalization.md`.

## Restrições globais

• Sem Supabase, novo banco, nova senha compartilhada ou alteração de conexão MCP.
• Preservar JSON, métodos, caminhos, códigos, ETag, revisão, idempotência, Auth, RLS e auditoria.
• Não repetir comandos nem mudar backend depois de enviá-los.
• Somente os quatro módulos inventariados; demais recursos e worktree de documentos ficam preservados.
• Textos novos usam • como separador; preservar sintaxe técnica.

## Foco de revisão

• Token MCP usado no endpoint normal não pode virar credencial Auth.
• Escopo somente leitura não autoriza POST/PUT; revogação/recurso/expiração são revalidados.
• Requisições concorrentes não compartilham identidade pelo contexto assíncrono.
• Transporte não permite URL arbitrária, identidade por cabeçalho ou retry após resultado incerto.
• OpenAPI e tipos compartilhados continuam disponíveis sem compilar handlers antigos na produção.

## Task 1 • Despacho privado MCP TypeScript

**Files:** `apps/api-ts/src/platform/mcp-dispatch.ts`, `access.ts`, `config.ts`, `app.ts`, `server.ts`; testes unitários e PostgreSQL em `apps/api-ts/test`.

**Interfaces:** `runWithMcpIdentity(identity, operation)` limita a identidade ao despacho interno; `registerMcpDispatch(app, dependencies)` valida token/grant e injeta a requisição tipada. O endpoint privado usa corpo/cabeçalhos limitados e somente rotas migradas.

- [x] Escrever e observar testes falhos de token inválido/expirado/revogado, recurso e escopo incorretos, identidade concorrente, headers forjados, URL arbitrária, corpo grande de produto e preservação de revisão/comando.
- [x] Implementar consulta de credencial compatível com `apps/api/src/mcp/oauth.rs`, isolamento assíncrono e registro privado.
- [x] Executar testes, tipos e build `api-ts`; registrar resultados e commit.

## Task 2 • Encaminhamento HTTP e MCP Rust

**Files:** novo `apps/api/src/platform/typescript_gateway.rs`; `platform/state.rs`, `config.rs`, `main.rs`, `mcp/mod.rs`, `http/mod.rs`; testes de transporte e MCP.

**Interfaces:** extensão `McpDispatchCredential` só é construída pelo MCP autenticado. Gateway recebe requisição original e origem validada, encaminha HTTP normal ou envelope MCP privado e conserva status/headers/bytes sem retry.

- [x] Observar testes falhos de encaminhamento HTTP/MCP, origem inválida, escopo/credencial não forjável, resposta de conflito sem segundo envio e permanência de recursos não migrados. A cobertura dedicada de timeout/perda de resposta no gateway Rust foi registrada como lacuna Minor na revisão final; o BFF cobre perda de resposta e a política do cliente Rust proíbe retry/redirecionamento.
- [x] Implementar gateway e rotas explícitas; manter referência separada até Task 3.
- [x] Executar fmt, testes relevantes e checagem Rust; registrar resultados e commit.

## Task 3 • Referência explícita e retirada dos handlers de produção

**Files:** `apps/api/Cargo.toml`, handlers dos módulos migrados, `http/openapi.rs`, fragmento de contrato versionado e `apps/api-ts/scripts/contract-tests.mjs`.

**Interfaces:** `migration-reference` conserva apenas a implementação anterior usada como oráculo; produção registra o gateway. OpenAPI de produção usa fragmento conferido contra as anotações da referência.

- [x] Testar igualdade de contrato/catálogo e provar escolha de handlers nas duas compilações.
- [x] Restringir handlers e helpers exclusivos à referência, conservando tipos/utilitários ainda usados por outros módulos.
- [x] Executar a matriz HTTP nas duas APIs e o MCP pelo gateway de produção, com PostgreSQL real; registrar resultados e commit.

## Task 4 • Runtime e encerramento da seleção gradual

**Files:** `apps/web/src/server/bff/erp-backend.ts`, testes BFF/navegador, `deploy/production-deploy.sh`, Compose, runtime/supervisor e seus testes.

**Interfaces:** módulos migrados usam TypeScript permanentemente; runtime sempre fornece o processo/origem privada. Retorno operacional usa a release anterior, não uma seleção parcial sem handlers antigos.

- [x] Testar ausência de retry, configuração incompleta, inicialização/saúde dos processos e retorno por release.
- [x] Atualizar runtime, empacotamento e exemplos sem ampliar segredos do processo TypeScript.
- [x] Executar verificações adequadas, build e navegador; registrar resultados e commit.

## Task 5 • Publicação e evidências finais

- [x] Revisão independente de toda a alteração e correções necessárias.
- [ ] PR/CI, merge e release com SHA exato, conservando a release anterior recuperável.
- [ ] Conferir navegador autenticado e MCP nos quatro módulos, origem TypeScript, empresa, ETag e saúde; somente leituras no ambiente real.
- [ ] Atualizar inventário, procedimento de retorno e memória com fatos verificados e limites.
