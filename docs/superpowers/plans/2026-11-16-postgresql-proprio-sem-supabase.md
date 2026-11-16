# PostgreSQL próprio sem Supabase • Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remover todo acoplamento ativo com Supabase e manter uma infraestrutura PostgreSQL própria, segura e neutra de fornecedor.

**Architecture:** O validador existente continuará separando credenciais de migration e runtime, mas validará um hostname PostgreSQL exato fornecido pelo operador. O runtime Cloudflare receberá apenas a conexão restrita e a documentação antiga de Supabase será substituída pelo contrato PostgreSQL aprovado.

**Tech Stack:** Python 3 • PostgreSQL/libpq • Node.js • Cloudflare Container runtime • unittest • node:test

**Spec:** `docs/superpowers/specs/2026-11-16-postgresql-proprio-sem-supabase-design.md`

## Global Constraints

• Supabase, Supabase Auth, Data API, Storage, Realtime e Edge Functions ficam fora da arquitetura.

• PostgreSQL, migrations SQL, SQLx, RLS, `tenant_id`, auditoria e outbox permanecem.

• Produção exige `sslmode=verify-full`.

• `DATABASE_MIGRATION_URL` nunca entra no contêiner de aplicação.

• Segredos não aparecem em argumentos, logs, documentação ou artefatos.

• Alterações locais não relacionadas em `docs/strategy` e `reports` permanecem intactas.

• Textos novos usam `•` como separador sempre que a sintaxe técnica não exigir outro caractere.

## Review Focus

• Host autorizado por prefixo ou sufixo malicioso deve ser rejeitado • teste em Task 1.

• Host local só deve funcionar com opt-in explícito • teste em Task 1.

• TLS fraco ou parâmetros duplicados devem falhar sem revelar senha • teste em Task 1.

• Credencial administrativa não pode alcançar o processo API ou web • teste em Task 2.

• Conteúdo ativo versionado não pode conservar referências ao Supabase • verificação em Task 3.

---

### Task 1: Generalizar o validador PostgreSQL

**Files:**
- Modify: `deploy/managed-postgres.py`
- Modify: `scripts/deploy/test_managed_postgres.py`

**Interfaces:**
- Consumes: `DATABASE_URL`, `DATABASE_MIGRATION_URL`, `POSTGRES_ALLOWED_HOST`, `--source-sha`
- Produces: `connection_environment(url: str, allowed_host: str, *, allow_local: bool = False) -> dict[str, str]`
- Produces: preflight e backup com as mesmas provas de schema, ledger, papel restrito e inventário

- [ ] **Step 1: Reescrever os testes de conexão para PostgreSQL neutro**

Cobrir hostname exato `postgres.internal.example`, porta 5432, senha codificada, `verify-full`, host falso por prefixo/sufixo, porta inválida, parâmetros duplicados, TLS fraco, esquema incorreto e opt-in local.

- [ ] **Step 2: Executar os testes e confirmar a falha esperada**

Run: `python -m unittest scripts.deploy.test_managed_postgres.ConnectionTests -v`

Expected: FAIL porque a interface atual exige `project_ref` e hostnames Supabase.

- [ ] **Step 3: Implementar a validação por hostname exato**

Renomear `project_ref` para `allowed_host` em `connection_environment`, `query_json` e `backup_database`; exigir hostname DNS válido e igualdade exata fora do modo local; rejeitar usuários administrativos conhecidos; trocar `--project-ref` por `--allowed-host`, com fallback somente em `POSTGRES_ALLOWED_HOST`.

- [ ] **Step 4: Executar os testes do validador**

Run: `python -m unittest scripts.deploy.test_managed_postgres -v`

Expected: PASS.

- [ ] **Step 5: Revisar o diff da Task 1**

Confirmar que senha continua apenas em `PGPASSWORD`, que argv não contém URL e que backup/preflight mantêm o comportamento anterior.

### Task 2: Desacoplar o runtime Cloudflare

**Files:**
- Modify: `deploy/cloudflare/runtime-configuration.mjs`
- Modify: `deploy/cloudflare/runtime-resources.json`
- Modify: `scripts/cloudflare/runtime.test.mjs`
- Modify: `deploy/cloudflare/README.md`

**Interfaces:**
- Consumes: `POSTGRES_ALLOWED_HOST`, `DATABASE_URL`, flags de ativação existentes
- Produces: ambiente restrito do processo API e ambiente sem credenciais de banco para o processo web

- [ ] **Step 1: Reescrever fixtures e asserções para um host PostgreSQL neutro**

Substituir `SUPABASE_PROJECT_REF` por `POSTGRES_ALLOWED_HOST`; adicionar teste de host semelhante malicioso e manter o teste que rejeita `DATABASE_MIGRATION_URL` no runtime.

- [ ] **Step 2: Executar o teste e confirmar a falha esperada**

Run: `node --test scripts/cloudflare/runtime.test.mjs`

Expected: FAIL porque `runtime-configuration.mjs` ainda exige referência e domínios Supabase.

- [ ] **Step 3: Implementar a configuração neutra**

Validar igualdade exata entre `DATABASE_URL.hostname` e `POSTGRES_ALLOWED_HOST`; exigir `sslmode=verify-full`; rejeitar usuário administrativo; encaminhar somente as variáveis de runtime permitidas.

- [ ] **Step 4: Atualizar inventário e documentação Cloudflare**

Trocar a variável no JSON, remover links e linguagem Supabase e apontar para a nova documentação PostgreSQL própria.

- [ ] **Step 5: Executar a suíte Cloudflare**

Run: `node --check deploy/cloudflare/runtime-configuration.mjs`

Run: `pnpm test:cloudflare`

Expected: PASS.

### Task 3: Remover artefatos Supabase e publicar documentação oficial

**Files:**
- Delete: `deploy/supabase/README.md`
- Delete: `docs/superpowers/specs/2026-11-13-supabase-managed-runtime-design.md`
- Delete: `docs/superpowers/plans/2026-11-13-supabase-managed-runtime.md`
- Create: `docs/architecture/postgresql-operacional.md`
- Create: `docs/architecture/dados-saas-comercial.md`
- Preserve: `docs/superpowers/specs/2026-11-16-postgresql-proprio-sem-supabase-design.md`
- Preserve: `docs/superpowers/plans/2026-11-16-postgresql-proprio-sem-supabase.md`

**Interfaces:**
- Consumes: design aprovado e comportamento validado nas Tasks 1 e 2
- Produces: manual operacional PostgreSQL e referência dos schemas, tabelas e queries planejados

- [ ] **Step 1: Excluir os três artefatos dedicados ao Supabase**

Usar patch explícito somente nos caminhos listados.

- [ ] **Step 2: Criar o manual PostgreSQL operacional**

Documentar papéis, variáveis, TLS, migrations, preflight, backup, restauração, rotação de segredo, observabilidade, recuperação e checklist de publicação.

- [ ] **Step 3: Criar a arquitetura de dados SaaS comercial**

Documentar extensões candidatas, schemas atuais e planejados, tabelas existentes que não serão duplicadas, novas tabelas, pacote documental, transcrição, comunicações, relatórios, medição de uso, índices e queries oficiais.

- [ ] **Step 4: Verificar ausência de referências ativas**

Run: `rg -n -i "supabase" -g '!node_modules/**' -g '!target/**' -g '!dist/**' -g '!*.lock' -g '!.codex-session' .`

Expected: nenhuma ocorrência fora do histórico de decisão presente na especificação e no plano novos. Nesses dois documentos, a palavra aparece somente para registrar explicitamente a tecnologia proibida.

- [ ] **Step 5: Verificar links e arquivos documentados**

Confirmar que todos os caminhos citados existem e que nenhum documento aponta para `deploy/supabase` ou para os documentos removidos.

### Task 4: Verificação integrada

**Files:**
- Verify only: todos os arquivos alterados nas Tasks 1 a 3

**Interfaces:**
- Consumes: entregas das Tasks 1 a 3
- Produces: evidência de testes e diff revisado

- [ ] **Step 1: Executar testes PostgreSQL**

Run: `python -m unittest scripts.deploy.test_managed_postgres -v`

Expected: PASS.

- [ ] **Step 2: Executar testes Cloudflare**

Run: `pnpm test:cloudflare`

Expected: PASS.

- [ ] **Step 3: Executar a validação geral relacionada**

Run: `pnpm test:verification`

Expected: PASS.

- [ ] **Step 4: Inspecionar estado e diff**

Run: `git status --short`

Run: `git diff --check`

Run: `git diff -- deploy scripts docs/superpowers docs/architecture`

Expected: sem whitespace inválido, sem alteração em `docs/strategy` ou `reports`, e somente mudanças previstas.

- [ ] **Step 5: Entregar relatório**

Listar arquivos removidos, arquivos criados, interfaces renomeadas, testes executados e qualquer pendência externa. Não publicar, fazer merge ou alterar infraestrutura sem solicitação explícita.
