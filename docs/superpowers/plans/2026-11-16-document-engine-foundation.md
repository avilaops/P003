# Motor documental • fundação • Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Criar a fundação PostgreSQL do motor documental e expor a leitura tenant-scoped de pacotes na ordem oficial.

**Architecture:** Uma migration cria o schema privado `document_engine`, seis tabelas com chaves compostas por empresa, RLS forçada e invariantes de imutabilidade. A API Rust consulta o pacote por `tenant_id` e `packet_id`, entrega os itens ordenados por `position` e não reconstrói a sequência no frontend.

**Tech Stack:** PostgreSQL • SQLx • Rust • Axum • serde • utoipa

**Spec:** `docs/architecture/dados-saas-comercial.md`

## Global Constraints

• Toda tabela transacional nova tem `tenant_id`, chave composta nas referências, RLS ativada e forçada.

• `document_packet_items.position` é a fonte de verdade da ordem Pedido • Nota fiscal • Comprovante de pagamento • Contrato • Documentos adicionais.

• Binários permanecem fora do PostgreSQL; o banco guarda `storage_key`, mídia, tamanho e SHA-256.

• O frontend nunca acessa PostgreSQL diretamente.

• A API aplica autorização antes da consulta e só usa a transação tenant-scoped existente.

• Nenhuma infraestrutura externa é criada ou publicada nesta entrega.

## Review Focus

• Um pacote de outra empresa deve se comportar como inexistente • teste na Task 2.

• Posições repetidas ou não positivas devem ser rejeitadas pelo banco • teste na Task 1.

• Referências cruzadas entre empresas devem falhar pela foreign key composta • teste na Task 1.

• O estado selado não pode voltar para rascunho nem aceitar itens novos • teste na Task 1.

• A resposta deve preservar exatamente a ordem persistida, mesmo quando os tipos documentais não seguem a ordem sugerida • teste na Task 2.

---

### Task 1: Schema e invariantes do motor documental

**Files:**
- Create: `migrations/202611160005_document_engine.sql`
- Create: `apps/api/src/http/document_packet_tests.rs`
- Modify: `apps/api/src/http/mod.rs`

**Interfaces:**
- Produces: schemas e tabelas `document_engine.document_templates`, `document_template_versions`, `render_jobs`, `rendered_documents`, `document_packets`, `document_packet_items`
- Produces: chave de ordenação `(tenant_id, packet_id, position)` e referências compostas tenant-scoped

- [ ] **Step 1: Escrever testes SQLx que exigem as seis tabelas, RLS forçada, posições válidas, referências tenant-scoped e bloqueio de mutação após selagem**

- [ ] **Step 2: Executar os testes e confirmar falha por ausência do schema `document_engine`**

Run: `cargo test -p erp-next-api document_packet_tests --no-fail-fast`

Expected: FAIL porque a migration ainda não existe.

- [ ] **Step 3: Criar a migration com checks de estado, índices operacionais, políticas RLS e triggers de imutabilidade**

- [ ] **Step 4: Executar os testes da Task 1**

Run: `cargo test -p erp-next-api document_packet_tests --no-fail-fast`

Expected: PASS quando `DATABASE_URL` estiver disponível; sem banco local, a compilação de testes deve passar e a indisponibilidade deve ser registrada.

- [ ] **Step 5: Commit**

Commit: `feat(documents): add tenant-safe document engine schema`

### Task 2: Consulta ordenada de pacote documental

**Files:**
- Create: `apps/api/src/domains/document_packets.rs`
- Modify: `apps/api/src/domains/mod.rs`
- Modify: `apps/api/src/http/mod.rs`
- Modify: `apps/api/src/http/openapi.rs`
- Modify: `apps/api/src/http/document_packet_tests.rs`

**Interfaces:**
- Consumes: `document_engine.document_packets` e `document_packet_items`
- Produces: `GET /api/v1/document-packets/{id}`
- Produces: `DocumentPacketResponse { tenant_id, data: DocumentPacket }` com `items` em `position asc`

- [ ] **Step 1: Escrever testes do endpoint para autorização, isolamento entre empresas, not-found e ordem persistida**

- [ ] **Step 2: Executar os testes e confirmar 404 porque a rota ainda não existe**

Run: `cargo test -p erp-next-api document_packet_tests --no-fail-fast`

Expected: FAIL no teste da rota ausente.

- [ ] **Step 3: Implementar domínio, consulta única ordenada e rota protegida**

- [ ] **Step 4: Registrar o contrato OpenAPI e executar testes**

Run: `cargo test -p erp-next-api document_packet_tests --no-fail-fast`

Expected: PASS com banco disponível; a compilação deve passar em qualquer ambiente.

- [ ] **Step 5: Commit**

Commit: `feat(documents): expose ordered document packets`

### Task 3: Verificação integrada da fundação

**Files:**
- Verify: todos os arquivos alterados nas Tasks 1 e 2

**Interfaces:**
- Consumes: migration e endpoint concluídos
- Produces: evidência de compilação, contratos e diff limpo

- [ ] **Step 1: Executar formatação e compilação dos testes da API**

Run: `cargo fmt --all -- --check`

Run: `cargo test -p erp-next-api --no-run`

Expected: PASS.

- [ ] **Step 2: Executar validação de contratos**

Run: `pnpm test:verification`

Expected: PASS após registrar o novo endpoint no catálogo, se o gate o exigir.

- [ ] **Step 3: Revisar migration, RLS, OpenAPI, estado e whitespace**

Run: `git diff --check`

Expected: PASS e nenhuma alteração em `docs/strategy` ou `reports`.

- [ ] **Step 4: Commit de ajustes de verificação, se necessário**

Commit: `test(documents): verify document engine foundation`
