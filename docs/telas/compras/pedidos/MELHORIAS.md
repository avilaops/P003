# Melhorias: Pedidos de compra

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md)

**Rota:** `/compras/pedidos` • **Código:** `apps/web/src/features/purchasing/purchase-access.tsx` → `PurchaseList` • **Capturas:** web 47.

## O que está errado hoje

- **Sem título de página**: a tela começa com o botão "Novo pedido de compra" e o link "Contas a pagar" lado a lado (link de outro módulo como ação da lista).
- "0 compra(s)"; paginação de uma página.
- Estado vazio bom no conteúdo ("Nenhuma compra cadastrada neste módulo. Os documentos antigos preservados podem ser consultados no histórico importado."), mas sem ação destacada.
- Sem filtros nem colunas definidas para quando houver dados.

## O que fazer

1. Cabeçalho padrão: "Pedidos de compra", primário "Novo pedido de compra"; "Contas a pagar" sai daqui (fica no menu Financeiro e no detalhe da compra).
2. Estado vazio: manter a menção ao histórico importado e adicionar o botão.
3. Colunas: Número, Fornecedor (nome + CNPJ mascarado), Previsão de entrega (selo "Atrasada"), Situação (Rascunho, Confirmado, Parcialmente recebido, Recebido, Cancelado), Valor.
4. Filtros: busca, situação (padrão: abertos), fornecedor, período.
5. Do detalhe: "Registrar recebimento" e "Ver contas a pagar geradas" (cadeia compra → recebimento → pagamento, documento seção 4).

## Critérios de aceite

- Título presente; nenhuma ação de outro módulo na barra da lista.
