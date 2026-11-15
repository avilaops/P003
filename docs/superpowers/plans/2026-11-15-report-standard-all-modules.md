# Todos os emissores de relatórios • Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Aplicar o padrão aprovado do contrato a todas as saídas documentais e relatórios operacionais existentes e publicá-lo no ERP pelo fluxo normal.

**Architecture:** Reutilizar CommercialDocument/DocumentSection no frontend e o renderer PDF vetorial no servidor. Os relatórios operacionais expõem visualização de impressão da consulta carregada, com escopo, período e empresa identificados. Documentos normativos e assinados não são redesenhados.

**Tech Stack:** React/Next.js, CSS A4, Rust/pdf-writer, Playwright e GitHub Actions.

**Spec:** docs/superpowers/specs/2026-11-15-commercial-document-standard.md

## Global Constraints

• Empresa do documento deve coincidir com a empresa autenticada e com a fonte de dados.
• Nenhum registro ausente é inventado; declarar limites/página da consulta.
• Não enviar e-mail real, registrar pagamentos ou reescrever arquivos assinados na validação.
• Manter a ordem pedido • nota • comprovantes • contrato • demais anexos.
• Manter leiautes fiscais, CSV/XML e fontes indisponíveis como estão.
• Usar • em textos e preservar a sintaxe de código.

## Review Focus

• Troca de empresa entre consulta e impressão não pode imprimir dados sob outro emitente.
• Fonte negada, indisponível ou carregando não pode gerar relatório aparentemente completo.
• Recibo deve preservar valores/identificadores e não inventar quitação.
• A4 longa deve conservar cabeçalho, rodapé, colunas e todas as linhas.
• Publicar somente a revisão integrada e aprovada nos gates.

## Tarefas

- [x] Conferir emissores reais, aliases e limites no código; registrar ampliação autorizada.
- [x] Relatórios operacionais: financeiro, estoque, serviços, gerencial/vendas/produtos/clientes • componente reutilizável, impressão e testes de isolamento.
- [x] Pacote contratual: pedido e recebimentos em PDF, a partir do snapshot preservado; testes de conteúdo, ordem e metadados.
- [x] PDV: comprovante no padrão compartilhado, emitente validado e impressão sem tela operacional.
- [ ] Rodar testes pertinentes, lint, tipos, arquitetura, cargo check e revisão integrada.
- [x] Conferir SMTP central e fluxos de envio existentes de pedido, proposta e pacote com servidores simulados; integrar a suíte de documentos/SMTP ao gate de navegador.
- [ ] Criar PR com o conjunto local aprovado, acompanhar CI, integrar e executar Release da revisão exata.
- [ ] Confirmar saúde e revisão pública do ERP após ativação; registrar o resultado real.

## Contexto da execução

O checkout main estava em 7dd3e699 com as alterações locais de pedidos/propostas e ordenação de pacote desta conversa. Elas foram preservadas na branch feat/report-document-standard-20261115. Não há modificações de terceiros identificadas fora desse conjunto. Duas tarefas independentes foram delegadas pela skill dispatching-parallel-agents; o coordenador mantém PDV, validação integrada e publicação.

O usuário reforçou concluir a implantação e incluir o envio SMTP. Os fluxos existentes usam o SMTP global em Preferências • Sistema • E-mail; serão validados configuração, permissões, revisão, anexos e tratamento de envio incerto. Não disparar mensagens reais para clientes durante testes e não inventar credenciais ou configurar outro provedor.
