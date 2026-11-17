# Ludus • fluxo comercial completo • Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. One fresh whole-branch reviewer at the end.

**Goal:** Publicar orçamento protegido e completo, pedido preservado e contrato preparado automaticamente, com catálogo verificável.

**Architecture:** Estender os endpoints de propostas em TypeScript com o motor comercial existente e snapshots por versão em PostgreSQL. Reutilizar a integração nativa de contratos, com preparação transacional, revisão e envio explícitos.

**Tech Stack:** TypeScript, Fastify, PostgreSQL, Next.js, integração de contratos existente.

**Spec:** `docs/superpowers/specs/2026-11-17-commercial-complete.md`

## Global Constraints

- Sem Supabase; regras novas em TypeScript; não alterar worktrees de outras tarefas.
- Usar • em textos e rótulos; dados desconhecidos não serão inventados.
- Não enviar e-mail, assinatura, cobrança ou venda real como teste.
- RLS, permissões, If-Match e idempotência obrigatórios. Preservar documentos históricos.
- Execução contínua autorizada; registrar decisões e evidências no ledger deste plano.

## Review Focus

- Cliente/endereço alterado após cálculo não pode trocar silenciosamente UF ou regime fiscal.
- Revogação de permissão e edição concorrente não podem revelar snapshots privados ou consumir aprovação antiga.
- Versão antiga e proposta genérica sem tabela publicada devem continuar consultáveis e não ganhar dados atuais.
- Perda de resposta na conversão/geração não pode duplicar pedido, contrato ou envio.
- Bateria não aplicável é diferente de bateria de peso desconhecido em equipamento com pilha.

### Task 1: Cotação comercial da proposta e persistência

**Files:** `apps/api-ts/src/modules/proposals/{schema,prepare,commands,snapshot,commercial}.ts`, migration `202611170001_commercial_proposals.sql`, testes em `apps/api-ts/test/commercial-proposals.test.ts` e `commercial-proposal-cases.ts`.

**Interfaces:** Consome `prepareMixed(context, input)` e `MixedInput`; produz `prepareProposalCommercial(context,input,prepared)` e snapshots por versão, com projeção segura.

- [x] Escrever testes de preço forjado, digest vencido, cliente fiscal divergente, isolamento de tenant, dados técnicos congelados e ocultação de custos; executar e observar falhas corretas.
- [x] Adicionar contrato opcional de cotação, persistência RLS, snapshots técnicos e validações do cálculo comum, sem modificar caminhos genéricos sem tabela.
- [x] Executar `pnpm --filter api-ts test` com PostgreSQL descartável e `pnpm --filter api-ts typecheck`. Expected: todos passam sem skips de PostgreSQL.
- [x] Commit do incremento testado.

### Task 2: Aprovação e pedido sem perda de acordo

**Files:** `apps/api-ts/src/modules/proposals/{transitions,commercial}.ts`, `apps/api-ts/src/modules/commercial/approvals.ts`, testes Task 1.

**Interfaces:** Consome cotação versionada; produz `commercial_order_quotes`, associação de versões e snapshot/checkout preservados na mesma conversão.

- [ ] Testar desconto fora da alçada, aprovação gerência/diretoria, tabela alterada, replay concorrente e rollback sem pedido órfão.
- [ ] Revalidar formalização e transferir a cotação para o pedido; exigir nova versão para acordo alterado.
- [ ] Rodar suíte API completa e typecheck. Expected: tudo passa.
- [ ] Commit do incremento testado.

### Task 3: Editor e documento de orçamento

**Files:** `apps/web/src/features/sales/{proposals,proposal-document,proposal-commercial}.tsx`, tipos/OpenAPI e testes web de propostas.

**Interfaces:** Usa endpoints existentes de tabela e simulação; envia cotação Task 1 e mostra snapshot técnico versionado.

- [ ] Reproduzir ausência de medidas/bateria e impossibilidade de negociar com regra comum em testes de navegador; cobrir PF/PJ, nome longo, troca de empresa e teclado.
- [ ] Integrar editor compacto, alçada e desconto; exibir dados técnicos congelados no PDF/tela; adequar contrato OpenAPI aditivo.
- [ ] Executar modelos web, testes de propostas em 390/1440, typecheck/lint/build. Expected: sem vazamento/corte e cotação aprovada converte corretamente.
- [ ] Commit do incremento testado.

### Task 4: Preparação automática de contrato e modelos comerciais

**Files:** módulo TS de preparação junto de pedidos/propostas, migração correspondente, integração nativa `apps/api/src/domains/contracts`, telas `apps/web/src/features/contracts` e testes do fluxo.

**Interfaces:** Consome snapshot aprovado; produz preparação única por pedido/revisão e prévia recuperável; integração existente gera/envia somente com os comandos autorizados.

- [ ] Testar preparação automática, uso dos termos aprovados, modelo de teste bloqueado, duplicação por replay e indisponibilidade do provedor.
- [ ] Implementar snapshot transacional e continuidade automática de geração, com problema explícito e revisão/envio separados.
- [ ] Executar API/PostgreSQL, testes nativos de contratos e navegador. Expected: nenhuma assinatura ou mensagem externa automática.
- [ ] Commit do incremento testado.

### Task 5: Catálogo Core e tabelas completas

**Files:** `scripts/maintenance` com plano de importação e testes; fontes técnicas JSON/manifesto sem fotos binárias; documentação de carga.

**Interfaces:** Planilha original por SKU, readback da API e resposta da paleta nacional; saída é plano determinístico com before/after/proveniência e rollback.

- [ ] Testar interpretação decimal, medidas, baterias, IDs ausentes/duplicados, revisão alterada e preservação de preço/imagem.
- [ ] Preparar carga dos 66 perfis, paleta autorizada e inclusão dos dois produtos omitidos na versão publicada, sem fontes presumidas.
- [ ] Ensaiar com rollback, backup e aplicar após runtime compatível; verificar por API cada produto e todos os itens das duas tabelas. Expected: dados completos conforme fontes, pendências externas explicitadas.

### Task 6: Revisão, CI e produção

- [ ] Revisão independente final com spec/plan/ledger e diff completo; corrigir achados relevantes com regressão RED→GREEN.
- [ ] Rodar checks exigidos, documentar contrato expandido e evidências, criar PR e integrar após CI verde.
- [ ] Publicar runtime/migração compatíveis, aplicar cargas revisadas e conferir health, contratos, tabelas e consultas autenticadas de produção.
- [ ] Registrar evidência requisito a requisito e apenas então concluir o goal.
