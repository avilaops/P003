# Pedido misto e ajustes fiscais • Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Permitir um pedido com equipamentos das duas tabelas e aplicar cabeçalho solicitado, preservando ajustes NF-e.

**Architecture:** Novas rotas mistas retrocompatíveis, cálculo por política e busca unificada; cabeçalho/exportação comercial separados do formulário. Backend, apresentação e integração têm ownership independente.

**Tech Stack:** Rust/SQLx/Postgres, React/Next.js, renderer A4 comercial, Playwright.

**Spec:** docs/superpowers/specs/2026-11-16-mixed-order-ui.md

## Constraints and review focus

• Não inventar regras financeiras nem liberar aprovação sem cálculo atual.
• Não quebrar schemas/API, pedidos históricos, POS ou consumo fiscal.
• Não vazar custos na busca, cópia ou PDF comercial.
• Preservar centavos e uma única cobrança de frete/taxa comum.
• Nenhuma emissão, envio real ou efeito financeiro nos testes.

## Tasks

- [x] Natureza NF-e em campo único e busca de produtos sobreposta • RED/GREEN,10testes,tipos/lint/revisão.
- [x] Backend misto • modelo, cálculo, snapshot/versões, rotas, migração e testes.
- [x] Cabeçalho e ações • copiar proposta/PDF seguros e padrão visual solicitado.
- [x] Integração UI • ambas tabelas, origem por item, simulação/conversão mistas, BFF e catálogo.
- [ ] Verificação integrada, revisão, PR, CI e Release da revisão exata; conferir saúde pública.

## Evidência local • 16/11/2026

• Modelo Rust isolado: 10 testes aprovados; `cargo check --locked --workspace --tests` aprovado. Testes SQL completos ficam no CI com PostgreSQL.
• Fluxos existentes do novo pedido: 34 testes de referência/mobile/entrada e 14 de CNPJ/cadastro aprovados.
• Pedido misto: duas fontes reais por item, sem versão global; busca, cálculo, cópia e PDF aprovados em Playwright. BFF misto: 2 testes de sessão, tenant, origem e encaminhamento aprovados.
• PDF gerado: A4, uma página, cabeçalho/identidade/contador e limites de impressão conferidos com PyMuPDF.
• Tipografia: título de 32px restrito ao cabeçalho solicitado; a política mantém bloqueios para outros seletores. Proposta omite frete pago pela empresa, taxa fixa, custos e margens.
• Revisão final identificou ausência de cliente/condições de pagamento na proposta; corrigido com snapshots de apresentação dos editores. Regressão RED/GREEN confirmou cliente, formas, valores/datas de parcelas editadas, prazo e observações na cópia/PDF, sem validar ou salvar o pedido.
• Catálogo/contexto: 45 testes aprovados e 500 rotas BFF conciliadas. Revisão final da correção de proposta sem problemas adicionais.
