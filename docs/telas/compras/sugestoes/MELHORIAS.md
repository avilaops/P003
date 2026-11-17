# Melhorias: Sugestões de compra

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md)

**Rota:** `/compras/sugestoes` • **Código:** `apps/web/src/features/purchasing/purchasing-capability-unavailable.tsx` • **Capturas:** web 49.

## O que está errado hoje

- Item marcado "Indisponível" no menu; abre a página genérica com 8 atalhos.
- A visão geral de Compras explica o motivo ("As sugestões de reposição exigem regras de estoque mínimo e demanda possíveis"), mas a própria tela não.

## O que fazer

1. Remover do menu enquanto indisponível.
2. Página específica por URL: "Sugestões de compra calculam o que repor com base em estoque mínimo e demanda. Para ativar, defina estoque mínimo nos produtos." + atalho "Configurar estoque mínimo" (Preferências → Suprimentos/Estoque).
3. Quando ativa: lista de produtos abaixo do mínimo ou com demanda de pedidos acima do disponível, quantidade sugerida editável, fornecedor preferido, ação "Gerar pedido de compra" para os selecionados (agrupando por fornecedor).

## Critérios de aceite

- Fora do menu enquanto indisponível; página específica explica como ativar.
