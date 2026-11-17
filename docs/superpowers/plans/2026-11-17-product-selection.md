# Seleção de equipamentos • Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Facilitar a inclusão de produtos e restaurar compatibilidade com identificadores do catálogo histórico.

**Architecture:** Corrigir validação de referências a produtos no backend e melhorar o seletor existente em tarefas independentes. O backend mantém o contrato; o frontend consome os mesmos PriceItem e onAdd.

**Tech Stack:** TypeScript, Fastify, Zod, PostgreSQL, React, Playwright.

**Spec:** docs/superpowers/specs/2026-11-17-product-selection.md

## Global Constraints

- Não alterar IDs ou dados comerciais no banco.
- Preservar autorização, isolamento da empresa e validação estrita das chaves de idempotência.
- A linha nacional não possui cores.
- Textos novos usam • como separador.
- Não salvar pedidos nem enviar mensagens reais na validação.

## Review Focus

- Identificador histórico aceito em leitura mas rejeitado ao negociar ou salvar.
- Duas linhas comerciais com o mesmo produto devem manter versão e preço corretos.
- Resultado obsoleto ou lista extensa não deve incluir produto diferente do destacado.
- Teclado, toque e nomes longos devem manter busca utilizável em 390 px.
- Limite de 100 itens e estado bloqueado devem continuar aplicados.

## Task 1 • Compatibilidade do catálogo

Owner: apps/api-ts/src/modules e helper de ID compartilhado; testes apps/api-ts/test.

- [ ] Reproduzir em teste o UUID histórico com variante não RFC sendo recusado.
- [ ] Implementar schema de ID de banco canônico e aplicá-lo às referências a produtos, incluindo GET, negociação, proposta e pedido. Auditar categorias e referências de entidades conexas, sem relaxar protocolo/idempotência.
- [ ] Demonstrar leitura e fluxo comercial no PostgreSQL isolado, além de rejeição de entradas malformadas e preservação dos controles existentes.
- [ ] Executar typecheck e testes específicos. Root integra e commita.

## Task 2 • Seletor compacto

Owner: apps/web/src/features/sales/commercial-order-layout.tsx, commercial-order.css e novo helper/componente se necessário; teste Playwright focado.

- [ ] Cobrir seleção por teclado, busca sem acento/palavras fora de ordem, repetição e conteúdo sobreposto sem alterar altura.
- [ ] Melhorar OrderEquipmentSearch mantendo interface items/selected/disabled/onAdd. Usar miniatura já disponível em PriceItem, fallback discreto, linha/SKU/preço, filtro de linha opcional local sem eliminar a mistura.
- [ ] Limitar altura, manter foco após inclusão, fechar com Esc/fora; impedir inclusão com disabled/100 itens, preservar fonte/versão no onAdd.
- [ ] Validar 390 px e desktop, typecheck/lint. Root integra e commita.

## Task 3 • Integração e publicação

- [ ] Revisão independente das duas tarefas e correção de achados reais.
- [ ] Integrar com main atual, abrir PR, aguardar somente os checks necessários e publicar uma vez.
- [ ] Conferir saúde e leitura do produto histórico em produção, sem escrita comercial real.
