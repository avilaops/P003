# Melhorias: Lançamentos de estoque

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md) • [Saldos](../saldos/MELHORIAS.md)

**Rota:** `/estoque/lancamentos` (e `/estoque/lancamentos/novo`) • **Código:** hoje `apps/web/src/app/estoque/lancamentos/page.tsx` reexporta `../page` (a tela de saldos) • **Capturas:** web 42.

## O que está errado hoje

- O item "Lançamentos de estoque" abre a **tela de saldos** (bug de rota confirmado no código). Não existe lista de movimentações nesta rota.

## O que fazer

1. Criar a tela própria de **movimentações**: lista com Data, Tipo (Entrada / Saída / Ajuste / Transferência / Reserva), Produto, Quantidade (+/−), Origem (pedido, compra, produção, manual • com link), Usuário.
2. Filtros: período (padrão últimos 30 dias), tipo, produto, origem.
3. Ação primária "Novo lançamento" (rota `/estoque/lancamentos/novo`, que já existe), com tipo primeiro e campos condicionais; motivo obrigatório em ajuste (documento seção 4: registrar usuário, data, motivo).
4. Estorno de lançamento manual com confirmação e registro (documento seção 7.1).
5. Estado vazio: "Nenhuma movimentação no período." + "Novo lançamento".

## Critérios de aceite

- `/estoque/lancamentos` lista movimentações, não saldos.
- Cada movimento com origem rastreável por link.
