# Melhorias: Contas a receber

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md)

**Rota:** `/financeiro/contas-receber` • **Código:** `apps/web/src/features/finance/receivables-access.tsx` • **Capturas:** web 52.

## O que está errado hoje

- 0 contas a receber, enquanto existem 4 pedidos (R$ X) em rascunho. O estado vazio ("Consulte os pedidos de venda para conferir a origem dos títulos e as condições de pagamento") não explica **quando** um título nasce.
- Sem filtros, totais, agrupamento por vencimento (aging) nem visão por cliente • mesmo que hoje esteja vazio, a estrutura não aparece.
- Ação de topo "Consultar pedidos" é a única.

## O que fazer

1. Estado vazio: "Os títulos a receber são gerados quando o pedido é aceito (confirmado). Há 4 pedidos em rascunho." + link "Ver pedidos em rascunho".
2. Com títulos:
   - Resumo: Vencido, Vence hoje, Próximos 7 dias, Próximos 30 dias (clicáveis como filtro).
   - Colunas: Vencimento (selo "Vencido há N dias"), Cliente, Pedido de origem (link), Parcela (2/6), Forma de pagamento, Valor, Saldo, Situação.
   - Filtros: período de vencimento, situação (Aberto / Pago / Vencido / Cancelado), cliente, forma de pagamento.
   - Ações: "Registrar recebimento" (por linha e em lote), "Enviar cobrança por e-mail" (a API já tem `receivables/{id}/email`), estorno com motivo.
   - Total do filtro no rodapé; exportar CSV/XLSX.
3. Indicador "inadimplência e prazo médio" (documento seção 10) no resumo.

## Mobile

- Cartão: cliente, vencimento (selo), valor; ação "Registrar recebimento" por deslizar ou botão.

## Critérios de aceite

- Estado vazio explica a origem dos títulos e aponta os pedidos em rascunho.
- Aging clicável quando houver dados.
