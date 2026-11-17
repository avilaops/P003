# Melhorias: Ordens de produção

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md)

**Rota:** `/estoque/ordens-producao` • **Código:** `apps/web/src/features/production/production-workspace.tsx` • **Capturas:** web 44.

## O que está errado hoje

- **Sem título de página**: a tela começa com um parágrafo longo ("Cada ordem conserva o produto e a quantidade vendidos. Registre os componentes efetivamente consumidos. Marcar como pronta registra a conclusão…").
- Botões "Enviar pedido à produção" (primário) e **"Recarregar produção"** (ação técnica de atualizar) lado a lado.
- "0 ordem(ns) • Consulta e operação"; paginação com uma página.
- "Configurar etapas da produção" num acordeão no rodapé • configuração misturada com operação.
- Sem visão por etapa (fila, em produção, pronta), que é como a fábrica acompanha.

## O que fazer

1. Cabeçalho padrão: "Ordens de produção", descrição de uma linha, primário "Enviar pedido à produção".
2. Explicação longa vai para "Como funciona" (link) ou estado vazio.
3. Remover "Recarregar produção" (atualizar automaticamente ou ícone discreto de atualizar).
4. **Kanban por etapa** (as etapas configuradas) com cartões: pedido de origem, cliente, produto/quantidade, prazo, dias na etapa. Alternar para lista.
5. "Configurar etapas" em Preferências → Suprimentos/Produção (ou "Mais ações"), não no rodapé.
6. Estado vazio: "Nenhuma ordem em produção. Envie um pedido aceito ou reservado para começar." + botão.
7. Alerta de ordens atrasadas em relação ao prazo de fabricação do pedido.

## Mobile

- Lista agrupada por etapa; mudar etapa por menu no cartão.

## Critérios de aceite

- Título presente; nenhuma ação técnica de "recarregar"; etapas visíveis.
