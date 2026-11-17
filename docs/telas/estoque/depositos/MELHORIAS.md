# Melhorias: Depósitos de estoque

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md) • [Componente compartilhado](../../cadastros/contas-financeiras/MELHORIAS.md#nota-sobre-o-componente-compartilhado)

**Rota:** `/estoque/depositos` • **Código:** `apps/web/src/features/records/reference/reference-access.tsx` • **Capturas:** web 45.

## O que está errado hoje

- 0 depósitos na empresa de exemplo; estado vazio genérico ("Nenhum cadastro encontrado. Revise os filtros…").
- Não explica para que serve o depósito. Hoje os saldos são consolidados por produto e empresa, sem divisão por depósito (descrição em `reference-config.ts`).
- Botão "Novo cadastro" genérico; filtros e paginação visíveis com a lista vazia.

## O que fazer

1. Botão primário "Novo depósito".
2. Estado vazio de primeiro uso: "Depósitos identificam os locais físicos do estoque (galpão, loja, showroom)." + "Novo depósito". Só mencionar saldos por depósito quando o estoque passar a dividir saldos por local.
3. Com registros: Código, Nome, Localização, Situação.
4. Saldo por depósito e depósito padrão ficam para quando o estoque dividir saldos por local.

## Critérios de aceite

- Com 0 depósitos, a tela explica para que serve e oferece a criação, sem prometer saldo por depósito.
