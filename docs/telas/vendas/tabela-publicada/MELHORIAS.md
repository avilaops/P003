# Melhorias: Tabela publicada (Tabela de preços)

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md)

**Rota:** `/vendas/tabela-precos` • **Código:** `apps/web/src/features/sales/commercial-table.tsx`, `commercial-table-cart.tsx`, `commercial-table-destinations.tsx` • **Capturas:** web 29.

## Objetivo

Mostrar ao vendedor o preço publicado de cada equipamento para o destino escolhido e até onde ele pode negociar, e montar o carrinho para abrir o pedido.

## O que está errado hoje

- Alerta no topo "Há produtos ou custos alterados após a publicação. Confira os itens disponíveis" **e** a mesma mensagem repetida em **todas as linhas** ("Produto ou custo alterado, indisponível ou fora da tabela. Atualize e publique a tabela").
- As colunas "Com 20% desc. + IPI", "Máx. sua alçada" e "Menor preço c/IPI" mostram **"Indisponível" em todas as linhas** • a tabela perde a função principal (alçada do vendedor).
- Mesmo assim, cada linha oferece "+ Pedido" e "Simular pedido".
- Navegação interna em links soltos sobre a tabela ("Simulador", "Pedidos", "Nova tabela de preços", "Preços e metas por destino"), misturando ações de vendedor e de gestão.
- "Sua alçada de desconto por destino" em acordeão; "Seu acesso: Diretoria" em texto pequeno à direita.
- Linhas altas (nome, SKU, aviso de 2 linhas) • poucas por tela.

## O que fazer

1. **Separar o problema de publicação do uso diário:**
   - Para quem pode publicar (gestão/diretoria): faixa de alerta única com contagem ("12 produtos mudaram desde a publicação de 09/11") e botão "Revisar e publicar".
   - Para o vendedor: mostrar só os itens disponíveis por padrão; itens indisponíveis num filtro "Indisponíveis (12)" com o motivo **uma vez**, no detalhe.
2. Investigar por que "Máx. sua alçada" e "Menor preço" estão indisponíveis para todos (provável tabela desatualizada • `availability.status = settingsStale`/`itemsUnavailable` em `PriceTable`). Se a causa for a publicação, a correção é publicar; a tela deve dizer isso em vez de repetir "Indisponível".
3. Colunas: Equipamento (nome + SKU), Preço s/ IPI, Preço c/ IPI, **Menor preço na sua alçada** (destaque), Ação. "Com 20% desc." vira tooltip ou coluna opcional.
4. Contexto (Linha Importada/Nacional, UF de destino, Contribuinte) numa barra fixa no topo da tabela, com o resumo da alçada visível ("Sua alçada: até 18% • Diretoria").
5. Navegação interna como abas ou menu "Gestão da tabela" (Nova tabela, Preços e metas por destino) visível só para quem gerencia.
6. Carrinho: contador fixo "3 itens • Abrir pedido" ao adicionar.
7. Desabilitar "+ Pedido" em item indisponível, com o motivo no tooltip.

## Mobile

- Cartões: nome, preço c/ IPI, menor preço da alçada, botão "+".
- Contexto (linha, UF, IE) em um seletor compacto no topo.

## Critérios de aceite

- Nenhuma mensagem repetida em todas as linhas.
- Com a tabela atual, o vendedor vê os itens disponíveis e o menor preço da alçada; a gestão vê "Revisar e publicar" com a contagem.
