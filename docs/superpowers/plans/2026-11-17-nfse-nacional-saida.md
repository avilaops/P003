# NFS-e Nacional de Saída Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer o ERP P003 emitir, consultar e cancelar NFS-e Nacional de MEI por comandos idempotentes autenticados de serviço.

**Architecture:** A API TypeScript é a autoridade de tenant, idempotência, persistência e auditoria. O `fiscal-engine` TypeScript monta, assina, valida e transmite DPS/NFS-e v1.01; certificado e transporte nunca chegam ao app consumidor. Nenhum código novo desta iniciativa será adicionado à API Rust em retirada.

**Tech Stack:** Node 24 • TypeScript • Fastify 5 • PostgreSQL/pg • Zod 4 • XMLDSig • XSD NFS-e Nacional v1.01 • SEFIN Nacional.

**Spec:** `C:\Users\nicol\source\app.avilaops.com\docs\superpowers\specs\2026-11-17-cobranca-personalizada-nfse-design.md`

## Global Constraints

- Emitente inicial • MEI de Ribeirão Preto • SP • IBGE `3543402`.
- Emissão somente pela SEFIN Nacional; nenhum adaptador Bling ou ISSNet.
- Produção fiscal desligada até homologação explícita.
- Toda escrita exige credencial de serviço tenant-bound e `Idempotency-Key` UUID.
- XML, A1 e senha permanecem no ERP; logs nunca os reproduzem.
- Separar NFS-e de saída de `fiscal_received_nfses`.

## Review Focus

- Repetição da mesma chave com corpo diferente responde `409` e nunca transmite novamente • Task 4.
- Timeout após transmissão produz estado `uncertain`, consulta antes de qualquer repetição • Tasks 2 e 4.
- Certificado de outro CNPJ bloqueia antes do transporte • Task 2.
- Tenant incorreto não consegue consultar XML ou cancelar documento • Task 4.
- Competência, centavos e código de serviço inválidos falham sem reservar emissão • Tasks 1 e 4.

---

### Task 1: Contrato DPS/NFS-e v1.01

**Files:**
- Create: `apps/fiscal-engine/src/lib/fiscal/nfse-issuance.ts`
- Create: `apps/fiscal-engine/tests/nfse-issuance.test.ts`
- Modify: `apps/fiscal-engine/src/engine.ts`

**Interfaces:**
- Consumes: `assertNationalNfseLayout(xml, "1.01")` e utilitários A1 existentes.
- Produces: `prepareNationalNfse(input): Promise<PreparedNationalNfse>` e operação `prepare-nfse` no dispatcher.

- [ ] **Step 1: Escrever testes falhos para valores exatos, competência, Ribeirão Preto `3543402`, MEI, tomador CPF/CNPJ e campos desconhecidos**
- [ ] **Step 2: Rodar `pnpm --dir apps/fiscal-engine test` e confirmar falha por operação ausente**
- [ ] **Step 3: Implementar tipos estritos e montagem determinística da DPS v1.01 sem transporte**
- [ ] **Step 4: Validar XML no pacote XSD pinado e rodar a suíte até passar**
- [ ] **Step 5: Commit `feat(fiscal): preparar DPS nacional de MEI`**

### Task 2: Assinatura e transporte SEFIN

**Files:**
- Create: `apps/fiscal-engine/src/lib/fiscal/nfse-sefin.ts`
- Create: `apps/fiscal-engine/tests/nfse-sefin.test.ts`
- Modify: `apps/fiscal-engine/src/engine.ts`
- Modify: `apps/fiscal-engine/src/server.ts`

**Interfaces:**
- Consumes: `PreparedNationalNfse` da Task 1 e cofre A1 existente.
- Produces: `issueNationalNfse`, `consultNationalNfse`, `cancelNationalNfse` e operações HTTP internas `issue-nfse`, `consult-nfse`, `cancel-nfse`.

- [ ] **Step 1: Testar mTLS, XMLDSig, CNPJ do certificado, produção restrita, timeout incerto e sanitização de erro**
- [ ] **Step 2: Confirmar testes vermelhos com adaptador ausente**
- [ ] **Step 3: Implementar cliente injetável com endpoints SEFIN configurados por ambiente e limites de 45 s**
- [ ] **Step 4: Rodar `pnpm --dir apps/fiscal-engine test` e confirmar aprovação**
- [ ] **Step 5: Commit `feat(fiscal): integrar emissão nacional de NFS-e`**

### Task 3: Persistência fiscal de saída

**Files:**
- Create: `migrations/202611170001_outgoing_nfse.sql`
- Create: `apps/api-ts/src/modules/outgoing-nfse/model.ts`
- Create: `apps/api-ts/test/outgoing-nfse-model.test.ts`

**Interfaces:**
- Consumes: tenant UUID, `external_id`, snapshot e hash da requisição.
- Produces: estados `pending|processing|authorized|rejected|uncertain|cancelled`, comandos e eventos append-only.

- [ ] **Step 1: Testar constraints, unicidade `(tenant_id, external_id)`, snapshot imutável e eventos append-only**
- [ ] **Step 2: Rodar o teste TypeScript e confirmar falha sem migration/modelo**
- [ ] **Step 3: Criar tabelas, RLS, índices, permissões e mapeamentos TypeScript**
- [ ] **Step 4: Rodar `pnpm --filter api-ts test --test-name-pattern outgoing_nfse` e `pnpm --filter api-ts typecheck`**
- [ ] **Step 5: Commit `feat(fiscal): persistir NFS-e de saída`**

### Task 4: API privada idempotente

**Files:**
- Create: `apps/api-ts/src/modules/outgoing-nfse/schema.ts`
- Create: `apps/api-ts/src/modules/outgoing-nfse/service.ts`
- Create: `apps/api-ts/src/modules/outgoing-nfse/routes.ts`
- Create: `apps/api-ts/test/outgoing-nfse.test.ts`
- Modify: `apps/api-ts/src/app.ts`
- Modify: `apps/api-ts/src/platform/config.ts`

**Interfaces:**
- Consumes: `ServiceIdentity`, `Idempotency-Key`, cliente do motor e modelo da Task 3.
- Produces: `POST/GET /api/v1/integrations/nfse/issuances`, download XML e cancelamento.

- [ ] **Step 1: Testar 401, tenant, idempotência, conflito, estados incertos, XML e cancelamento**
- [ ] **Step 2: Confirmar falha antes das rotas**
- [ ] **Step 3: Implementar rotas Fastify privadas com transações e auditoria**
- [ ] **Step 4: Rodar testes, typecheck e a matriz contratual aplicável da API TypeScript**
- [ ] **Step 5: Commit `feat(api): expor emissão privada de NFS-e`**

### Task 5: Operação e homologação segura

**Files:**
- Modify: `.env.example`
- Modify: `deploy/` arquivos do fiscal-engine aplicáveis
- Create: `docs/fiscal/nfse-nacional-saida.md`
- Create: `verification/nfse-national-issuance.mjs`

**Interfaces:**
- Consumes: endpoints das Tasks 2 e 4.
- Produces: flags `NFSE_ISSUANCE_ENABLED`, URLs por ambiente e verificador sem dados reais.

- [ ] **Step 1: Testar que produção permanece bloqueada sem flag, certificado e cadastro completos**
- [ ] **Step 2: Documentar provisionamento, rollback, consulta de estado e evidências de homologação**
- [ ] **Step 3: Rodar `pnpm --filter api-ts test`, `pnpm --filter api-ts typecheck`, `pnpm --dir apps/fiscal-engine test`, `pnpm verify:erp` e arquitetura**
- [ ] **Step 4: Executar Produção Restrita com fixture autorizada pelo usuário; não ativar produção sem sucesso verificável**
- [ ] **Step 5: Commit `docs(fiscal): preparar homologação da NFS-e Nacional`**

