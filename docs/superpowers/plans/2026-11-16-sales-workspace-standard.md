# Vendas • padrão operacional • plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implementar a especificação enviada em 16/11 para Vendas, propostas, pedidos e estrutura compartilhada, com rascunhos retomáveis e informação real por empresa.

**Architecture:** Reutilizar API e controles existentes. Consultas recentes limitadas a cinco e contagens filtradas no servidor; componentes compartilhados mantêm temas, navegação protegida e permissões.

**Tech Stack:** Next.js, React, TypeScript, CSS, Base UI, Rust, SQLx/PostgreSQL e Playwright.

**Spec:** Mensagem do usuário de 16/11/2026 • sete seções e capturas de visão geral, propostas, pedidos e Novo pedido. Pedidos primeiro; Novo pedido principal; Novo orçamento secundário; contagens reais de rascunhos clicáveis; tabelas brancas sobre fundo neutro; títulos 28–32px; status textual; ações Continuar/Abrir; preservação de busca, filtros e rolagem; identificação segura da empresa; claro/escuro/sistema; teclado, 200% e telas estreitas. A estrutura visual deve se propagar pelos componentes compartilhados, sem reescrever os fluxos fiscais/financeiros.

## Global Constraints

• Separadores de texto usam •.
• Sem gravar pedidos, enviar e-mail ou emitir documentos fiscais nos testes.
• Contagens não podem contar apenas a página carregada nem mostrar zero enquanto carregam.
• Nomes de empresa vêm do cadastro; não inventar abreviações comerciais.
• Preservar as proteções de edição pendente, idempotência e segregação por empresa.
• Manter as cores de catálogo já publicadas em f1b6bdf425c6b43c9fc1071bccb70ec36632425a.

## Review Focus

• Rascunhos fora da primeira página ainda entram na contagem.
• Usuário de consulta recebe Abrir e nenhuma ação de criação/edição.
• Falha de uma consulta não esconde os demais blocos.
• Empresa trocada não pode reutilizar dados visíveis da anterior.
• Nome longo, valor alto, 320px e 200% preservam ação e valor acessíveis.

### Task 1 • Contratos de consultas

- [ ] Verificar filtros e ordenação em `apps/api/src/domains/sales`, implementar filtro de status e ordenação por atualização nas listas quando ausentes, preservando comportamento padrão.
- [ ] Disponibilizar data real de atualização nas respostas, atualizar OpenAPI e tipos gerados conforme ferramentas do projeto.
- [ ] Testar contagem filtrada, ordenação recente, autorização e isolamento de empresas.

### Task 2 • Estrutura compartilhada

- [ ] Ajustar `apps/web/src/app/globals.css`, `workspace-ui.css`, `components/shell/*`, `components/page-header.tsx` para fundo neutro, superfícies brancas, tipografia nativa, títulos reais e navegação sem cartões/legenda duplicada.
- [ ] Preservar tema, guarda de navegação e botão de reabrir a lateral. Usar nome de exibição cadastrado quando disponível e nome legal acessível no seletor.
- [ ] Validar navegação por teclado, telas estreitas, contraste e zoom.

### Task 3 • Listas de propostas e pedidos

- [ ] Ajustar listas em `features/sales/proposals.tsx` e `orders.tsx`: cabeçalho consistente, filtros na URL, rascunho retomável, status compartilhado e cliente como texto com identificador principal.
- [ ] Preservar retorno à busca/filtros/página/rolagem usando mecanismos existentes e dados por empresa.
- [ ] Testar rascunho de edição/consulta, filtro recebido de indicador, retorno do detalhe e estados vazio/erro.

### Task 4 • Visão geral

- [ ] Reestruturar `features/sales/sales-workspace.tsx`: ações no cabeçalho, resumo de rascunhos, pedidos primeiro e até cinco recentes de cada tipo.
- [ ] Consultas e falhas independentes; datas reais quando disponíveis; identificadores, etiquetas e Continuar/Abrir conforme permissão.
- [ ] Retirar rodapé de atalhos; manter destinos nos menus próprios.
- [ ] Testar carregamento sem zero, totais acima de cinco, falha parcial, consulta, vazio e responsividade.

### Task 5 • Integração e publicação

- [ ] Executar lint, tipos, modelos e suítes de navegador afetadas com fixtures.
- [ ] Revisar alterações, completar CI, integrar PR e executar Release para SHA exato.
- [ ] Confirmar health público e testar leitura/navegação no ERP sem gravar registros de negócio.
