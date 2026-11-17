# Melhorias: Conferência de estoque (Inventários)

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md)

**Rota:** `/estoque/inventarios` • **Código:** `apps/web/src/features/inventory/inventory-counts.tsx` • **Capturas:** web 43.

## O que está errado hoje

- O menu chama "Conferência de estoque" (marcado "Indisponível"); a rota chama "inventarios"; a tela é a página genérica "Funcionalidade indisponível" com 8 atalhos.
- Existe um componente `inventory-counts.tsx`, mas a tela mostra indisponível • verificar se é bloqueio por capacidade/permissão ou por falta de backend.

## O que fazer

1. Escolher um nome (sugestão: "Inventário") e usar em menu, rota, título e documentação.
2. Se indisponível: tirar do menu; página específica com atalho para Saldos.
3. Quando ativa (documento seção 10: "acurácia de estoque"): criar contagem por depósito/categoria → lista de itens com saldo do sistema oculto (contagem cega opcional) → digitação da contagem (no celular, com leitor de código) → divergências → aprovar ajuste (gera lançamentos com motivo "Inventário").
4. Mobile é o caso principal de uso (contagem no galpão): campos grandes, teclado numérico, avanço automático.

## Critérios de aceite

- Nome único; nenhum acesso à página genérica pelo menu.
