# Melhorias: Compras • visão geral

[Padrão comum](../PADRAO-MELHORIAS.md) • [Guia do módulo](README.md)

**Rota:** `/compras` • **Código:** `apps/web/src/features/purchasing/purchase-access.tsx` (`view="overview"`) • **Capturas:** web 46.

## O que está errado hoje

- A "visão geral" é uma lista de links (Pedidos de compra, Recebimentos de compras, Contas a pagar) e um parágrafo, mais um bloco "Outras áreas de compras" com mais links.
- Nenhum número: compras abertas, recebimentos pendentes, atrasos, contas a pagar da semana.
- Vocabulário divergente do menu: "Recebimentos de compras" (aqui) × "Check-in de recebimentos" (menu); "Notas de entrada" × "Notas fiscais de entrada"; item "Fornecedores" no menu sem cartão aqui.

## O que fazer

1. Indicadores: pedidos de compra abertos (valor), aguardando recebimento, recebimentos atrasados, a pagar nos próximos 7 dias.
2. "Precisa de ação": compras com previsão de entrega vencida, notas recebidas sem pedido vinculado, sugestões de reposição (quando ativas).
3. Atalhos: "Novo pedido de compra" (primário), "Registrar recebimento", "Importar NF-e de entrada".
4. Unificar nomes com o menu (escolher "Recebimentos" e "Notas de entrada").
5. "Fornecedores" no menu leva a Clientes e fornecedores filtrado por fornecedor • deixar isso explícito no título da lista filtrada.

## Critérios de aceite

- Visão geral com números reais e mesma nomenclatura do menu.

---

Prompts das telas do módulo: [Pedidos de compra](pedidos/MELHORIAS.md) • [Recebimentos](recebimentos/MELHORIAS.md) • [Sugestões](sugestoes/MELHORIAS.md) • Notas de entrada → [Monitor fiscal](../fiscal/monitor/MELHORIAS.md).
