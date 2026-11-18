# Conferência de estoque

[Todas as telas](../../../README.md) · [Estoque](../README.md)

Conferir o fluxo de inventário e contagem disponível na empresa.

**Onde acessar:** `/estoque/inventarios`.

## O que aparece na tela

- Referência e situação do inventário
- Produtos ativos e saldo esperado na abertura da sessão
- Quantidades de contagem e situação

## O que você pode fazer

- Informar uma referência e clicar em Criar sessão
- Abrir a sessão e informar a quantidade contada de cada produto
- Conferir se todos os produtos foram contados
- Aprovar ajustes quando a sessão estiver aberta e completa

## Regras e limites

A abertura registra a posição dos produtos selecionados. É possível filtrar por categoria, selecionar o depósito quando habilitado e bloquear a movimentação dos itens durante a conferência. Na contagem cega, o operador informa a quantidade sem consultar o saldo esperado. A aprovação aplica as divergências e identifica a sessão em cada ajuste. O cancelamento libera os itens bloqueados.

## Referências para manutenção

Guia conferido no código de 12/11/2026. As ações dependem das permissões e da configuração da empresa. Relatos técnicos antigos descrevem a etapa em que foram escritos.

- [inventory-counts](../../../../apps/web/src/features/inventory/inventory-counts.tsx)
