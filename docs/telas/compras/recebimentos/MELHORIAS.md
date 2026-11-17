# Melhorias: Recebimentos de compra (Check-in de recebimentos)

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md)

**Rota:** `/compras/recebimentos` • **Código:** `apps/web/src/features/purchasing/purchase-access.tsx` → `PurchaseList receiving` • **Capturas:** web 50.

## Diagnóstico confirmado

A rota usa o mesmo `PurchaseList` dos pedidos de compra, só com `receiving={true}`. Com a lista vazia, a tela fica **idêntica** a Pedidos de compra: mesmo botão "Novo pedido de compra", mesmo link "Contas a pagar", mesmo texto "0 compra(s)", sem título.

## O que está errado hoje

- Visualmente indistinguível de Pedidos de compra.
- A ação principal oferecida é criar pedido de compra, não registrar recebimento.
- Nome do menu "Check-in de recebimentos" diferente da visão geral ("Recebimentos de compras").

## O que fazer

1. Título "Recebimentos"; descrição "Compras confirmadas aguardando chegada da mercadoria."
2. Lista padrão = pedidos de compra **aguardando recebimento** (total ou parcial), com Previsão (selo "Atrasado"), Fornecedor, Itens pendentes, ação "Registrar recebimento".
3. Aba "Recebidos" com o histórico (data, conferente, divergências, nota fiscal vinculada).
4. Sem botão "Novo pedido de compra" aqui.
5. Estado vazio: "Nenhuma compra aguardando recebimento." + link "Ver pedidos de compra".
6. Registrar recebimento no celular (galpão): conferência item a item, quantidade recebida, divergência com motivo, foto opcional.

## Critérios de aceite

- A tela é visualmente e funcionalmente diferente de Pedidos de compra mesmo vazia.
- Nome igual no menu, no título e na visão geral.
