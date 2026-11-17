# Melhorias: Garantias e assistência técnica

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md)

**Rota:** `/vendas/garantias` • **Código:** `apps/web/src/features/sales/warranty-workspace.tsx`, `warranty-assignment.tsx` • **Capturas:** web 36.

## O que está errado hoje

- Cabeçalho do bloco "0 solicitações registradas" e corpo "Nenhuma solicitação registrada." dizem a mesma coisa.
- O subtítulo descreve um fluxo (elegibilidade, triagem, reparo, aprovação, encerramento), mas a tela não mostra essas etapas.
- Sem filtros, sem busca por cliente, número de série ou pedido de origem.
- Breadcrumb "Vendas / Pós-venda" diferente do item de menu "Garantias".

## O que fazer

1. Estado vazio único: "Registre aqui os chamados de garantia e assistência dos equipamentos vendidos. Cada chamado passa por elegibilidade, triagem, reparo e encerramento." + "Nova solicitação de garantia".
2. Com registros: abas ou filtros por etapa (Elegibilidade, Triagem, Reparo, Aguardando aprovação, Encerradas) com contagem; colunas Número, Cliente, Equipamento/série, Pedido de origem (link), Etapa, Aberta há N dias, Responsável.
3. Busca por cliente, série e pedido.
4. Alerta de chamados parados.
5. Do detalhe do pedido, ação "Abrir garantia" já preenchendo cliente e itens (continuidade do fluxo, documento seção 4).

## Critérios de aceite

- Sem mensagem duplicada no vazio; etapas visíveis como filtros com contagem.
