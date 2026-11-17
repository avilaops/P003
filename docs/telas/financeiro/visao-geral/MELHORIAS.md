# Melhorias: Financeiro • visão geral

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md)

**Rota:** `/financeiro` • **Código:** `apps/web/src/features/finance/finance-overview.tsx` • **Capturas:** web 51.

## O que está errado hoje

- Faixa azul longa no topo: "Recebimentos e pagamentos registrados no ERP são declarações manuais. Eles não transferem dinheiro nem comprovam liquidação bancária. Saldos de bancos e caixas só são exibidos quando houver lançamentos vinculados a uma conta financeira."
- "Operações disponíveis": seis cartões **sem números** (Contas a receber, Contas a pagar, Comissões, Contas financeiras, Categorias financeiras, Formas de pagamento) • três deles são cadastros que já estão em Cadastros.
- "Integrações pendentes": quatro cartões com explicação técnica ("Saldo e lançamentos dependem de um ledger financeiro vinculado à conta", "CNAB exige arquivo, banco, carteira e reconciliação configurados").
- Não mostra o que o financeiro precisa ver primeiro: a receber e a pagar hoje/semana, vencidos, saldo por conta.

## O que fazer

1. Indicadores: A receber (7 dias), Vencido a receber, A pagar (7 dias), Vencido a pagar, Saldo nas contas (quando houver contas).
2. Lista "Vencendo hoje e atrasados" (receber e pagar juntos, com sinal), com ação "Registrar recebimento/pagamento".
3. **Configuração pendente** quando faltar: "Nenhuma conta financeira cadastrada" e "Nenhuma categoria financeira" com links (a empresa de exemplo está assim) • substitui a faixa azul.
4. A explicação sobre "declarações manuais" vai para um "Saiba mais" e para o formulário de registro de pagamento, onde importa.
5. Remover cartões de cadastros (ficam em Cadastros) e o bloco "Integrações pendentes" (vira item de roadmap em Preferências → Integrações, não na operação diária).
6. Fluxo de caixa projetado simples (30 dias) quando houver títulos (documento seção 9.2, item 1).

## Critérios de aceite

- A tela mostra números reais ou a configuração pendente que impede tê-los; nenhum texto técnico de integração.
