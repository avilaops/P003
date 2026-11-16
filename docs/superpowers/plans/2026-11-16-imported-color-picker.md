# Cores importadas • Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Aplicar paletas reais aos importados e selecionar cores com imagem em lista compacta.

**Architecture:** Catálogo de paletas/imagens existente, um seletor compartilhado acessível e compatibilidade de preço separada da revisão geral. Carga por API com revisão e backup, após publicação.

**Tech Stack:** React/Next, Rust/SQLx/Postgres, Playwright, GoogleDrive/Sheets read-only.

**Spec:** docs/superpowers/specs/2026-11-16-imported-color-picker.md

## Global Constraints
• Imagens originais e componentes separados; nacionais e histórico preservados.
• Sem cores inventadas, sem cor de anilheiro e sem republicar/recalcular preços.
• Nada de salvar pedidos, enviar e-mails ou emitir notas nos testes.

## Tasks
- [x] TDD • seletor compartilhado e apresentação compacta • desktop/mobile/teclado/scroll/histórico.
- [x] TDD • revisão de compatibilidade de preço, migração, queries de publicação/disponibilidade/negociação e regressão SQL.
- [x] Preparar backup/diff dos94produtos • preferênciaCableMotion e campos protegidos.
- [ ] Revisão integrada • lint/tipos/arquitetura/modelos/testes • PR/CI/Release.
- [ ] Aplicar dados autorizados comETAG/readback, validar preços e conferir imagens/lista no ERP real.

## Review Focus
• Popover dentro de details/tabelas/diálogos não pode ser cortado nem deslocar o layout.
• Campo obrigatório/histórico e ausência de paleta continuam corretos.
• Revisão nova não libera produto já desatualizado nem ignora mudança de custo/preço/unidade/status.
• Backfill não altera valores, ativos/arquivados, fotos, estoque, impostos ou snapshots.

## Evidências e decisões
• Paleta combinada autorizada pelo usuário:69Pro,21SForce,4combinados. Três produtos arquivados preservam status.
• Modelos e helper de carga:13testes RED/GREEN aprovados. Rasters originais preservados porSHA.
• PostgreSQL temporário real: migrações completas e regressões de revisão/compatibilidade aprovadas; `cargo check --locked --workspace --tests` aprovado. Suíte SQLx completa no CI.
• Arquitetura500rotas e45testes de contratos/contexto aprovados. Revisão final estática sem P1/P2.
• UI:33/37passaram inicialmente. Três falhas de navegação móvel passaram isoladamente. A fixture obsoleta disparava503na segunda consulta inicial do modo desenvolvimento; passou a simular503somente após a tentativa412real do cenário, preservando todas as verificações de retenção e nova versão.
• Preview autenticado de2produtos aprovado, sem escrita; confirmação de empresa/revisão e hash da foto incluídos. A carga exige SHA da Release aprovada e faz readback de cada produto; pendências não são repetidas cegamente.
• Repetição final:3cenários móveis aprovados e7testes focados aprovados, incluindo a fixture corrigida,320/393/1280,obrigatório/histórico,Khaki combinado e toque. TypeScript aprovado após congelar fontes.
