# Envio financeiro SMTP • Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Completar envio de título e relatório financeiro nas telas existentes e implantar pelo fluxo normal.

**Architecture:** Dois contextos de API com infraestrutura financeira compartilhada de snapshot/PDF/SMTP/histórico. Compositor React compartilhado, BFF autenticado e confirmação explícita.

**Tech Stack:** Rust/Axum/SQLx/Postgres, pdf-writer, Next.js/React, Playwright.

**Spec:** docs/superpowers/specs/2026-11-15-finance-document-email.md

## Global Constraints

• SMTP central; nenhum disparo real em testes.
• Valores e anexos vêm do servidor; máximo 100 registros por fonte no relatório.
• Conferir tenant, revisão/hash e permissões financeiras; nenhum efeito contábil pelo envio.
• Intenção e replay duráveis antes do SMTP; uncertain bloqueia novo envio.
• Preservar contrato/API e usar • nos textos.

## Review Focus

• Financeiro sem permissão comercial pode enviar; sem permissão financeira não pode.
• Alteração das fontes ou troca de empresa entre conferência e envio não publica snapshot diferente.
• Fechar e reabrir modal não perde comando pendente.
• Relatório inclui e identifica o mesmo recorte autorizado de ambas as fontes.
• Falha após aceite SMTP não causa segundo envio.

## Tasks

- [x] Backend • adicionar testes de revisão/hash/permissões/replay, migração RLS, PDF e SMTP financeiro; registrar rotas/OpenAPI.
- [x] Frontend • compositor compartilhado em recebível e relatório; testes de confirmação, falhas, troca de empresa e fechamento/reabertura.
- [x] BFF e integração • encaminhar rotas e validar autenticação, origem, revisão e chave; atualizar mapa/contrato e testes de arquitetura.
- [ ] Rodar verificações e revisão; concluir Release 43693854296 do padrão base em paralelo.
- [ ] PR e gates do incremento financeiro; integrar e publicar revisão exata; conferir saúde pública.
