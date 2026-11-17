# Melhorias: Simulador comercial

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md) • [Prompt do Novo pedido](../../../strategy/novo-pedido-ux-prompt.md) • [Proposta de layout](../../../strategy/novo-pedido-layout-proposta.md)

**Rota:** `/vendas/simulador` • **Código:** `apps/web/src/features/sales/commercial-simulator.tsx` (o mesmo arquivo serve o Novo pedido) • **Capturas:** web 30.

## Objetivo

Simular preço, desconto e entrada antes de abrir o pedido. O documento estratégico pede eliminar telas duplicadas (seção 9.1, item 4): Simulador e Novo pedido são a mesma montagem com finalidades diferentes.

## O que está errado hoje

- Duas formas de adicionar equipamento na mesma área: campo "Buscar equipamento" **e** select "Selecione um equipamento" + botão "Adicionar".
- Faixa "Equipamentos • Condições • Resultado • Cliente" parece abas, mas é só navegação por âncora • e "Cliente" no simulador confunde (simulação não exige cliente).
- Botão "Simular" no topo à direita, desabilitado, longe de onde o usuário trabalha; o resultado aparece numa coluna estreita à direita com "Adicione equipamentos para calcular preços e entrada".
- Acordeão **"Dados para criar o pedido"** com o triângulo ► sozinho numa linha e o título na linha de baixo (defeito visual).
- Links soltos no topo ("Tabela de preços", "Pedidos", "Parâmetros e metas", "Regras de aprovação"); "Tabela v6 • Simulação não salva" em texto miúdo.
- Slider de desconto com "Livre até 20%. Acima disso, exige aprovação." sem mostrar o teto nem a faixa de aprovação.

## O que fazer

1. Usar os **mesmos componentes do Novo pedido** definidos na [proposta de layout](../../../strategy/novo-pedido-layout-proposta.md): linha/cartão compacto de item, painel de acabamentos, resumo fixo com a condição comercial (desconto máximo, entrada mínima, motivo, aprovador).
2. Uma única forma de adicionar: busca com resultados (a mesma `OrderEquipmentSearch`).
3. **Calcular automaticamente** ao mudar itens/condições (debounce), sem botão "Simular".
4. Remover "Cliente" da navegação do simulador; manter a ação final "Criar pedido com esta simulação", que leva os itens e condições para o Novo pedido.
5. Corrigir o acordeão "Dados para criar o pedido" (ícone e título na mesma linha) ou eliminá-lo com o item 4.
6. Faixas de desconto (livre / aprovação / teto) no controle, como no Novo pedido.
7. Links de gestão (Parâmetros e metas, Regras de aprovação) só para quem gerencia, em "Mais ações".

## Mobile

- Igual ao Novo pedido: cartões de item, barra inferior com total e "Criar pedido".

## Critérios de aceite

- Simulador e Novo pedido usam a mesma linha de item, painel de acabamentos e resumo.
- Resultado recalcula sem clicar em "Simular".
- "Criar pedido com esta simulação" abre o Novo pedido já preenchido.
