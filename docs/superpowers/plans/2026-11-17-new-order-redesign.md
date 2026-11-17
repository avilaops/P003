# Novo Pedido • Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Entregar o Novo Pedido compacto, acessível e responsivo em cinco PRs ordenados.
**Architecture:** Uma leitura TypeScript em lote fornece acabamentos/peso sem fotos em base64. Um cache por empresa no formulário alimenta linhas e painel únicos. Sheet existente resolve foco/modalidade; layout e navegação reutilizam o estado do Simulator.
**Tech Stack:** TypeScript, Fastify/pg/Zod, React/Next, Base UI Sheet/Dialog, CSS atual, Playwright.
**Spec:** docs/superpowers/specs/2026-11-17-new-order-redesign.md

## Global Constraints

- Não mudar regras comerciais nem bibliotecas/dependências.
- API nova somente de leitura em lote, com tenant/RLS e catalog.products.read.
- Nacional não possui cores; não inventar dados ou obrigatoriedade de acabamento.
- Preservar labels, comandos de escrita e máscaras; usar • em textos novos.
- Sem testes com operações comerciais reais; migração geral permanece pausada.

## Review Focus

- Resposta de empresa anterior ou ID ausente não pode alimentar acabamentos/peso do pedido atual.
- Aplicação em massa não pode apagar escolhas incompatíveis ou colorir produto nacional.
- Totais defasados não podem ser apresentados como cálculo atual nem liberar salvamento.
- Foco em campo/acionador deve permanecer visível com barras fixas e painel modal.
- Pedidos grandes, nomes longos e valores altos devem caber nos cinco breakpoints.

## A • Corrigir erro e leitura em lote

Arquivos backend: novo modules/products/finishes.ts, registro em routes.ts, teste dedicado PostgreSQL. BFF: erp-backend.ts e erp-proxy.ts; aproveitar handler dinâmico products/[id] para leitura /products/finishes ou criar handler literal com contrato verificável se necessário.

Interface: GET /api/v1/products/finishes?ids=GUID,GUID (1..100 IDs canônicos, normalizados/deduplicados). Resposta `{ tenantId, data: ProductFinishes[], missingIds: string[] }`. ProductFinishes contém id,name,structureColors,swingArmColors,finishingPalette,upholsteryColors,upholsteryConfigurable,plateHolderColors,plateHolderTypes,weight:string|null. Sem fotos/custos/regras privadas. Queries somente tenant-scoped; missingIds não distingue produto de outra empresa de inexistente.

Frontend: novo order-product-details.ts hook, interface abaixo; Simulator usa lote para orderMode, cenário simulador mantém leitura existente. OrderWeightSummary aceita pesos previamente conhecidos e não faz chamadas individuais para o novo pedido. Erro dentro do bloco de acabamento, sem campos vazios. Integração mantém SelectedProduct até PR B.

Hook: `useOrderProductDetails(tenantId, ids, enabled=true)` retorna `{ products: Record<string,ProductFinishes>, loadingIds:string[], errors:Record<string,string>, retry:(id?:string)=>void }`; cache em estado isolado por tenant, dedupe faltantes, abort e identidade explícita da resposta. Nunca chamar getter por linha. batch max100.

- [ ] Preservar correção GUID já validada (commitc8b61d6c), sem repetir toda suíte.
- [ ] Testar lote com GUID legado, duas empresas/RLS, IDs malformados/limite, omissão/fotos/custos e inexistente.
- [ ] Implementar endpoint/BFF e hook; atualizar fixtures necessárias e capturar “antes” da lista atual14 itens375/1280 antes de PR B.
- [ ] Verificar chamadas e troca de empresa/falha/retry; PR A e merge com checks necessários.

## B • Lista e painel

Arquivos: novo order-equipment-list.tsx/.css, order-finishes-panel.tsx, order-equipment-model.ts; Simulator substitui somente equipment area. Reaproveitar picker do commitbf86b3d3 (ainda local, já passou30 testes). Não mudar preço/estado da negociação.

Props da lista: items: SelectedOrderItem[], prices: PriceItem[], sale: Sale|null, tenantId, disabled, details: retorno hook, onUpdate(productId,next), onRemove(productId), onUpdateMany(updates). Exportar tipo SelectedOrderItem com as mesmas chaves de Selected atual (inclui line/versionId/quantidade/cores/anilheiro). Widget encapsula filtro/recolhimento/painel, soma tabela por quantidade válida e usa orderEquipmentWeight para peso.

- [ ] Linha desktop/cartão móvel de duas linhas, chips nomeados, colunas condicionais, sticky/filter/recolher após8.
- [ ] Sheet existente com drawer/sheet responsivo e anterior/próximo mantendo foco; aplicar cores compatíveis com feedback textual, sem sobrescrever incompatíveis.
- [ ] Estados de loading/erro/missing únicos, retry individual/global. Busca de adição permanece acima.
- [ ] Teste de teclado,14acabamentos, incompatibilidade/nacional, densidade375/1280. PR B após A.

## C • Resumo

Arquivos: commercial-order-layout.tsx/.css, order-mobile-navigation.tsx (somente OrderQuickSummary), novo order-summary.tsx se necessário; Simulator passa os mesmos totals/save nodes e pesos.

- [ ] Coluna direita começa na linha1 e fica sticky, resumo/salvar agrupados. Mobile fixedbar safe-area com total/pendências/Salvar; botão resumo abre Sheet existente.
- [ ] Não duplicar IDs/elementos interativos visíveis; foco e altura útil preservados. Mostrar valores de tabela conhecidos antes da simulação com rótulo explícito.
- [ ] Testar total+pendência em topo/meio/fim375/1280, estados unknown/stale/loading e save sem escrita real. PR C após B.

## D • Seções e pendências

Arquivos: order-progress.ts, order-mobile-navigation.tsx (navigation/pending/focus), nova order-section-navigation.css; order-customer-form.tsx apenas assinatura de progresso e foco da seleção, modelo de mensagens curtas.

- [ ] Cliente vazio/cadastro fechado gera uma pendência; campos após escolha/cadastro iniciado. Mensagens curtas sem limites técnicos, manter validação original.
- [ ] IntersectionObserver scroll-spy, botão ativo e contagem visível, máximo48px móvel. Contagem aria-live debounced, sem anúncio por tecla.
- [ ] Pendência abre seções e foca campo; recolhimento manual somente com resumo e sem perder dados.
- [ ] Testar1pendência cliente, ordem/campo/collapse e scrollspy. PR D após C.

## E • Formulários e aceite

Arquivos: commercial-checkout.tsx, order-customer-form.tsx, order-negotiation-fields.tsx, CSS específicos; testes commercial-checkout-ui.spec.ts e nova matriz local reutilizável.

- [ ] Ajuda curta com Saiba mais; causas comuns dos dois botões de parcelas em um único aviso; manter mensagens específicas e aria-describedby.
- [ ] Reaproveitar CNPJ/CEP/máscaras; inputMode, touch44px e foco sem cobertura.
- [ ] Matriz1/14/40itens375/1280 e geometria768/1024/1440; screenshotsantes/depois e medidas de densidade, sem virtualização não justificada.
- [ ] Revisão final, typecheck/lint/testes existentes pertinentes, PR E; relatório com PRs/validações/limitações reais.
