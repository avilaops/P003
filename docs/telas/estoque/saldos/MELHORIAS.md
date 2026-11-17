# Melhorias: Estoque • visão geral e Saldos

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md) • [Lançamentos](../lancamentos/MELHORIAS.md)

**Rotas:** `/estoque` (Visão geral) e `/estoque/saldos` • **Código:** `apps/web/src/app/estoque/page.tsx` → `apps/web/src/features/inventory/stock-access.tsx` • **Capturas:** web 40, 41.

## Diagnóstico confirmado

`apps/web/src/app/estoque/saldos/page.tsx` e `apps/web/src/app/estoque/lancamentos/page.tsx` fazem `export { default } from "../page"`: **Visão geral, Saldos e Lançamentos abrem exatamente a mesma tela** ("Saldos por produto"). Três itens de menu, um conteúdo.

## O que está errado hoje

- Três rotas iguais (acima).
- Lista de 160 produtos com **0 UN em todos**, sem filtro para ver só quem tem saldo, saldo negativo ou reservado.
- Link "Cadastrar produto" solto no meio da página, entre a busca e a lista; "Consultar catálogo" no topo; ações de cadastro dentro do estoque.
- "SKU LD-B013 • Ativo" em texto minúsculo; "Ver movimentos" como link em cada linha, aumentando a altura.
- Sem valor de estoque e sem última movimentação. (Os saldos são consolidados por produto, sem divisão por depósito.)
- "160 produto(s) • Consulta e movimentação".

## O que fazer

1. **Separar as rotas:**
   - `/estoque` → **visão geral** com indicadores: itens com saldo, itens zerados com pedido aberto (ruptura), itens com reserva, valor do estoque (se houver custo), últimas movimentações.
   - `/estoque/saldos` → **lista de saldos** (esta tela, melhorada).
   - `/estoque/lancamentos` → **movimentações** (ver [Lançamentos](../lancamentos/MELHORIAS.md)).
2. Saldos • filtros: busca ao digitar, Situação do saldo (Com saldo / Zerado / Negativo / Com reserva), Categoria. Padrão "Com saldo" quando existir algum; senão "Todos" com aviso.
3. Colunas: Produto (nome + SKU), Saldo, Reservado, Disponível, Última movimentação. Clicar na linha abre os movimentos (remover o link "Ver movimentos" da linha).
4. Ação primária "Novo lançamento"; remover "Cadastrar produto" e "Consultar catálogo" daqui (ou mover para "Mais ações").
5. Exportar CSV.

## Mobile

- Cartão: produto, disponível (grande), saldo/reservado em secundário.

## Critérios de aceite

- Visão geral, Saldos e Lançamentos mostram conteúdos diferentes.
- Filtro "Com saldo" funcional; com tudo zerado, aviso claro.
