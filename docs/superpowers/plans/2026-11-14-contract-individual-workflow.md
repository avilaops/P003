# Contratos • Implementação do fluxo individual

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrar o serviço privado ao fluxo completo de participantes e documentos do ERP/portal, preservando legado e bloqueando conclusão sem ICP individual comprovada.

**Architecture:** Agregado separado com snapshots imutáveis e operações transacionais em PostgreSQL; cliente Rust autenticado consome o serviço já integrado. BFF e telas existentes recebem administração e acesso próprio de participante, sem alterar SSO ou permissões comerciais.

**Tech Stack:** Rust/Axum/SQLx/PostgreSQL, AES-GCM/SHA-256 já disponíveis, TypeScript/Next.js, testes Python existentes como referência de interoperabilidade.

**Spec:** `docs/superpowers/specs/2026-11-14-contract-individual-workflow-design.md`, subordinada a `docs/telas/servicos/contratos/referencias/ASSINATURA-ICP-INDIVIDUAL.md`.

## Global Constraints

- Mesma pasta solicitada pelo usuário; branch própria, sem novo worktree ou perda de arquivos locais.
- RLS forçada e FKs compostas tenant/envelope; identidade e evidência imutáveis.
- 10 participantes, 10 documentos, base 20 MiB, candidato 32 MiB, dois uploads pendentes por pessoa, 1 GiB por envelope, quarentena sete dias.
- Novas emissões `icp_each_participant`; históricos `legacy_docuseal`, sem migração retroativa de validade.
- Chaves pessoais, PFX, PIN e senha nunca recebidos; cifra de CPF usa chave própria de contratos, independente do A1 fiscal.
- Bundle preservado e conferido antes de qualquer CAS de head/participante.
- Sem nova dependência se biblioteca existente resolve; textos com `•`.
- Não habilitar convites reais ou alegar homologação sintética; não alterar SSO, custos nacionais em aberto ou modelos fora de escopo.

## Review Focus

- Falha entre gravação de prova e head: rollback integral, sem perda de prova aceita ou avanço vazio • Task 3.
- Worker antigo após novo lease e dois uploads simultâneos: somente o token/versão atual pode concluir, quota não excede • Task 3.
- CPF/ciphertext trocado entre participantes ou tenants: decifração falha e leitura comum permanece mascarada • Task 1.
- JSON/bundle válido isolado mas de outro contexto ou com evidência reclassificada: rejeição antes da persistência/avanço • Task 2.
- Portal exige segundo fator e link é repassado: sem verificação efetiva não nasce sessão apta a enviar • Task 4.

---

### Task 1: Persistência tipada e identidade protegida

**Files:** Create `migrations/202611140001_contract_individual_workflow.sql`, `apps/api/src/domains/contracts/individual/{mod,identity,identity_tests}.rs`, `apps/api/src/http/contract_individual_tests.rs`. Modify `apps/api/src/{domains/contracts/mod,http/mod}.rs` apenas para registrar módulos.

**Interfaces:** Produces tabelas `contract_signature_envelopes`, `contract_signature_participants`, `contract_signature_states`, `contract_signature_documents`, `contract_signature_revisions`, `contract_signature_heads`, `contract_signature_evidence`, `contract_signature_uploads`, `contract_signature_jobs`, `contract_signature_grants`, `contract_signature_sessions`; todos tenant/envelope. `PersonalCpf::parse(&str)`, `PersonalCpf::masked()`, `IdentityKeyring::seal/open(tenant,envelope,participant,cpf)` com AAD e erro opaco. Sem rota pública nesta tarefa; o fluxo existente só muda na Task 3.

- [x] Escrever testes PostgreSQL de classificação do legado, RLS sem bypass, FKs cruzadas, imutabilidade e constraints/índices antes da migration. Escrever testes de CPF real sintético válido/inválido, máscara, cifra aleatória e AAD cruzada.
- [x] Executar `cargo test --locked -p erp-next-api contract_individual -- --test-threads=2` com DATABASE_URL de teste local; observar falha por schema ausente. Testes de identidade devem falhar antes de implementar seu comportamento.
- [x] Implementar migration e identidade sem alterar snapshots históricos; registrar módulos e reutilizar AES-GCM/zeroize existentes, sem reusar chave fiscal.
- [x] Reexecutar a seleção inteira e testes legados de contratos; executar `cargo fmt --all --check` e clippy dos alvos modificados.
- [x] Commit explícito dos arquivos da tarefa, com evidência RED/GREEN no ledger.

Task 1 verificada • commit `e246b83`, CI `43627261243` aprovado: 538 testes API passaram, um teste anterior ignorado, mais sete auxiliares aprovados; os sete casos novos e o contrato legado constam no log. O merge sintético testado `1ced35c3d2978ce37eb0234e151a8394b95eb996` tem árvore igual ao head. `cargo fmt --all --check` e `cargo clippy --locked -p erp-next-api --all-targets -- -D warnings` passaram localmente. RED do schema, identidade e vínculo ao pai foi observado antes da implementação; a compilação antiga com stubs cancelada não é resultado GREEN. A expectativa temporária de dead_code fora de testes sai quando a Task 3 conectar a identidade ao runtime. A PR 216 continua rascunho até concluir as tarefas restantes; nenhum deploy ou homologação foi feito.

### Task 2: Cliente autenticado e interoperabilidade

**Files:** Create `apps/api/src/domains/contracts/individual/{client,transport,bundle,wire_json,codec_tests}.rs`; modify `apps/api/src/config.rs`, `apps/api/src/main.rs`, `apps/api/src/platform/state.rs`; vetores em `apps/api/tests/fixtures/contract-wire/` e geração de interoperabilidade em `scripts/contracts/`.

**Interfaces:** Consumes IDs/hashes/política fixada da Task 1; produces `ValidatorClient::preflight/validate` e `VerifiedBundle` com bytes completos/hash, contexto tipado, veredito e evidência. `VerifiedBundle` só nasce no codec verificado, não por JSON/struct público do chamador.

- [ ] Testes RED para frame/autenticação iguais aos vetores Python, contexto trocado, replay, JSON duplicado/profundidade, overflow/tail, MAC interno/externo, evidência tipada e perfil sintético recusado em produção.
- [ ] Implementar transporte e parsing limitados, confiança fixada e TLS; prazo de resposta e limite de corpo antes da alocação. Não duplicar parsing criptográfico PDF/DER.
- [ ] Executar testes de interoperabilidade Rust/Python, falhas de rede e limites; confirmar `accepted` somente com todas as verificações.
- [ ] Commit com RED/GREEN e resultados.

### Task 3: Congelamento, fila transacional e avanço concorrente

**Files:** Create `apps/api/src/domains/contracts/individual/{workflow,store,worker,quotas,workflow_tests}.rs`; modify `contracts/{mod,model,sync,api,package}.rs` e configuração/worker real existente; expandir `http/contract_individual_tests.rs`.

**Interfaces:** Consumes IdentityKeyring, VerifiedBundle e schema. Produces funções `freeze`, `freeze_documents`, `reserve_upload`, `claim_job`, `complete_job` com tenant e versões/lease obrigatórios. `complete_job` grava prova e aplica CAS na mesma transação. API administrativa sob READ/MANAGE/SEND existentes.

- [ ] RED: três pessoas/dois PDFs; provider concluído não conclui ICP; nenhum convite antes da identidade/política congeladas; falha de prova reverte head; lote incompleto impede próximo participante e pacote.
- [ ] RED: concorrência de reserva, 2 uploads, 1 GiB, base20/candidato32, 10/10; replay, lease vencido/substituído, head pai antigo, permissão revogada e tenant cruzado.
- [ ] Implementar geração explícita individual, origem/hashes dos PDFs finais, preflight completo, leases/outbox/CAS e quarentena/retentiva. Contabilizar reservas e bytes aceitos sem races; preservar caminho legado.
- [ ] Executar testes PostgreSQL sob papel normal, testes legados e testes de serviço; OpenAPI com DTOs sem CPF claro.
- [ ] Commit com evidências e decisões.

### Task 4: Sessões de titular, BFF e telas

**Files:** Create módulos de grant/session no domínio individual e rotas BFF/participante conforme arquitetura web existente; modify `apps/web/src/features/contracts/`, páginas e contratos OpenAPI. Read `apps/web/AGENTS.md` antes de mudar UI.

**Interfaces:** Consumes workflow/admin API; produces troca de grant por sessão própria, download do head correto e upload PDF com CAS. Grant/session armazenam apenas hashes; verificação efetiva do portal e 2FA são condições do servidor.

- [ ] RED: grant uma vez/curto, sessão expirada/revogada/cruzada, origem inválida, titular futuro e 2FA não comprovada; link não concede membership nem ICP.
- [ ] Implementar rotas estreitas/cookie seguro sem migração SSO nem impersonação; limites de upload no BFF e API. UI administrativa apresenta estado real e máscara, UI titular baixa/assina localmente/devolve.
- [ ] Browser testes em 375/768/1024/1440, teclado e erros recuperáveis; lint, typecheck e build web; nenhuma entrada PFX/PIN/senha.
- [ ] Commit com resultados.

### Task 5: Pacote completo, revisão e integração

**Files:** `contracts/package.rs`, testes de pacote/restauração por hash, documentação da tela, relatório de entrega e checklist de homologação; workflows existentes só se necessário.

**Interfaces:** Consumes todos os heads/evidências concluídos; produces manifesto completo e arquivos verificáveis, sem preview fallback. Evidências e revisões fora da limpeza de releases; comprovantes posteriores separados.

- [ ] RED: falta um documento/bundle, hash divergente, prova de outro envelope, tentativa de usar preview ou primeiro PDF; pacote recusado.
- [ ] Implementar pacote completo e testes de restauração por hash; manter distribuição/retentiva adicional do componente 4 explícita quando ainda pendente.
- [ ] Fmt/clippy/testes workspace, lint/typecheck/build web, browser e interoperabilidade. Uma revisão independente do componente inteiro; corrigir Critical/Important com regressão RED/GREEN.
- [ ] PR, checks obrigatórios e merge conforme autorização existente, sem deploy bloqueado ou bypass. Documentar commits/checks, decisões e exatamente o que falta para homologação real e ativação.

## Cobertura integral

Política/identidades/RLS • Task 1/3. Serviço autenticado/prova • Task 2. Imutabilidade/quotas/fila/leases/CAS • Task 1/3. Sessão/2FA/admin/titular • Task 4. Todos os heads/provas/retentiva • Task 3/5, complementado pelo componente 4. Homologação real • checklist Task 5 e componente 5, sem declarar satisfeita por fixtures. Nenhuma tarefa isolada equivale à conclusão do objetivo completo.
