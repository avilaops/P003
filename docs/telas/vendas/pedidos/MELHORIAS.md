# Melhorias: Pedidos de venda (lista)

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md) • [Novo pedido: prompt](../../../strategy/novo-pedido-ux-prompt.md) • [Novo pedido: proposta de layout](../../../strategy/novo-pedido-layout-proposta.md)

**Rota:** `/vendas/pedidos` • **Código:** `apps/web/src/features/sales/orders-access.tsx`, `orders.tsx`, `sales-record-list.tsx` • **Capturas:** web 32. A tela **Novo pedido** (`/vendas/pedidos/novo`) tem prompt e proposta próprios (links acima).

## O que está errado hoje

- Coluna **"Vencimento"** numa lista de pedidos: não fica claro vencimento de quê (validade? entrega? primeira parcela?). PV-EXEMPLO tem "31/10/2026" (passado) e continua "Rascunho" sem alerta.
- CPF/CNPJ sem máscara sob o cliente.
- "Abrir" e "Continuar" sem regra visível; cancelado misturado aos ativos.
- Botão vago **"Mais opções"** ao lado de "Novo pedido"; "Tabela de preços" como ação de topo.
- "Pesquisar" e "5 pedido(s)"; sem filtro por vendedor, período, linha ou valor; sem total da lista.
- Sem coluna de vendedor nem de etapa (aprovação, produção, faturado, entregue • documento seção 4).

## O que fazer

1. Renomear a coluna para o que ela é (ex.: "Validade" ou "Prazo de entrega") • confirmar no `orders.tsx`/API qual data é. Mostrar selo "Vencido" quando passado.
2. Colunas: Pedido, Cliente (nome + CNPJ mascarado), Vendedor, Etapa (selo: Rascunho, Aguardando aprovação, Confirmado, Em produção, Faturado, Entregue, Cancelado), Data, Valor.
3. Filtros: busca ao digitar, Etapa (padrão: todas exceto Cancelado), Vendedor, Período. Total do valor filtrado no rodapé.
4. Ação por linha com regra única (rascunho → "Continuar", demais → "Abrir").
5. "Mais opções" vira "Mais ações" com itens explícitos (Exportar, Importar), ou some se não tiver itens úteis.
6. Rascunhos parados há mais de 7 dias com selo "Parado há N dias".

## Mobile

- Cartão: número + etapa (selo), cliente, valor, data; filtros em bottom sheet; "Novo pedido" no cabeçalho.

## Critérios de aceite

- A coluna de data tem nome inequívoco e PV-EXEMPLO aparece como vencido/parado.
- Cancelado só aparece quando o filtro inclui cancelados.
