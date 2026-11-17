# Melhorias: Visão geral e dashboards (Meu Negócio)

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md)

Este arquivo tem um prompt por tela. Aplique também todas as regras do padrão comum.

---

## Tela 1: Visão geral (página inicial)

**Rota:** `/` • **Código:** `apps/web/src/features/dashboard/erp-dashboard.tsx` • **Capturas:** web 01, mobile 01.

### Objetivo

Ser o ponto de partida do dia: o usuário vê o que precisa da atenção dele e chega à próxima ação com um clique (documento, seção 8: "exibir pendências e próxima ação"; seção 9.1, item 6: "painel de pendências e aprovações").

### O que está errado hoje

- A página tem só três botões (Novo pedido, Consultar estoque, Documentos fiscais) e o resto da tela vazio, no desktop e no celular.
- Não mostra nenhum número, pendência, aprovação, vencimento ou atividade recente.
- Os atalhos são fixos, iguais para todos os perfis.

### O que fazer

1. **Bloco "Precisa da sua atenção"** (topo, largura total), com contagem e link direto para a lista já filtrada:
   - Pedidos aguardando sua aprovação (alçada).
   - Pedidos em rascunho parados há mais de 7 dias.
   - Propostas vencidas ou vencendo em 3 dias.
   - Contas a receber vencidas; contas a pagar vencendo hoje.
   - Pendências de configuração que bloqueiam operação (sem conta financeira, sem depósito, certificado fiscal vencendo).
   Mostrar só os itens com contagem > 0; com tudo zerado, uma linha "Nada pendente agora".
2. **Indicadores do mês** (4 cartões): pedidos no mês (quantidade e valor), propostas abertas (valor), a receber nos próximos 30 dias, conversão proposta → pedido (documento, seção 10). Cada cartão abre o dashboard correspondente.
3. **Atalhos por perfil** (Vendedor, Financeiro, Estoque, Fiscal, Gestor • documento, seção 8): no máximo 4, a ação principal destacada ("Novo pedido" para vendas).
4. **Atividade recente**: últimos 5 documentos que o usuário criou ou alterou, com status.
5. Respeitar permissões: bloco sem permissão não aparece.

### Mobile

- Ordem: atenção → atalhos (2×2) → indicadores (rolagem horizontal de cartões é aceitável aqui) → atividade.

### Critérios de aceite

- Com os dados atuais da empresa de exemplo (4 pedidos em rascunho, PV-EXEMPLO de 30/10 parado, propostas de 08/11 e 11/11 vencidas), a página mostra esses itens como pendências.
- Nenhuma área vazia maior que um bloco no desktop 1280 px.
- Cada número leva a uma lista filtrada com o mesmo total.

---

## Tela 2: Dashboard geral

**Rota:** `/dashboards` (padrão) • **Código:** `apps/web/src/features/dashboard/dashboard-detail.tsx` • **Capturas:** web 05, mobile 04.

### O que está errado hoje

- Quatro cartões (Pedidos no período 4, Saldo a receber R$ 0,00, Saldo a pagar de compras R$ 0,00, Produtos ativos 157) e uma tabela "Pedidos por mês" com duas linhas. Metade da tela vazia.
- "Saldo a receber R$ 0,00" ao lado de R$ X em pedidos confunde: não explica que títulos só nascem quando o pedido é aceito.
- A tabela "Pedidos por mês" é idêntica à do Dashboard de vendas.
- "Produtos ativos" é um dado de cadastro, não um indicador de negócio.
- Texto "Saldos e cadastros refletem a posição atual" em linha solta.

### O que fazer

1. Trocar a tabela por **gráfico de colunas** pedidos × mês (valor) com linha de quantidade, mantendo a tabela em "Ver dados" (acessibilidade).
2. Cartões: Valor em pedidos no período, A receber (com tooltip "títulos de pedidos aceitos"), A pagar, Margem prevista (se disponível; senão omitir).
3. **Comparativo com o período anterior** em cada cartão (▲ 12% vs período anterior).
4. Seletor de período com rótulos claros ("Últimos 6 meses", "Este mês", "Este ano", "Personalizado"), não "6M".
5. "Atualizar" só se os dados não forem atualizados automaticamente; "Visualizar impressão/PDF" vira "Exportar PDF" em menu "Mais ações".
6. Rodapé: "Dados até 17/11/2026 18:10" em texto discreto.

### Mobile

- Cartões 2×2 (já está assim); gráfico com altura fixa de 200 px e rolagem horizontal se houver mais de 6 meses.

### Critérios de aceite

- Nenhum cartão mostra R$ 0,00 sem explicação.
- O gráfico e os cartões batem com a lista de pedidos para o mesmo período.

---

## Tela 3: Dashboard de vendas

**Rota:** `/dashboards?…vendas` • **Código:** `dashboard-detail.tsx` • **Capturas:** web 06, mobile 05.

### O que está errado hoje

- Cartões Pedidos 4, Valor R$ X Ticket médio, Cancelados 1, e a mesma tabela do Dashboard geral.
- Faltam os recortes que o documento pede (seção 10): conversão proposta → pedido **por vendedor, canal e linha**, tempo até aprovação, prazo pedido → faturamento.

### O que fazer

1. Cartões: Valor vendido, Pedidos, Ticket médio, Conversão proposta → pedido (%).
2. Gráfico de vendas por mês (igual ao geral, mas só vendas).
3. **Ranking por vendedor** (tabela: vendedor, propostas, pedidos, conversão, valor, desconto médio).
4. Vendas por linha (Importada / Nacional) e por UF de destino.
5. Cancelados viram link para a lista filtrada, não um cartão de destaque.
6. Subtítulo atual ("Pedidos não cancelados por data de criação. Valores de pedidos não representam faturamento ou recebimento.") vai para um ícone de informação.

### Critérios de aceite

- Ranking por vendedor mostra os 4 funcionários da empresa de exemplo (com zero quando não venderam).

---

## Tela 4: Margem por pedido

**Rota:** `/dashboards?…margem` • **Capturas:** web 07, mobile 06.

### O que está errado hoje

- Item ativo no menu que abre só "Análise ainda indisponível • Os dados necessários para esta análise ainda não estão disponíveis neste painel" e um link "Consultar pedidos reais".

### O que fazer

- **Se a margem não pode ser calculada:** remover o item do menu (padrão comum) até existir dado.
- **Se pode** (a simulação já calcula `director.netProfitCents` e `netProfitBps` por negociação): listar pedidos com margem prevista (%, R$), desconto aplicado, alçada usada, e destacar pedidos abaixo da meta. Filtros por vendedor, período e linha. Isso atende o indicador "margem prevista e realizada" (documento, seção 10).
- Verificar no backend se a margem fica preservada no pedido salvo antes de decidir.

### Critérios de aceite

- O item não aparece no menu, ou mostra dados reais; nunca uma página vazia.

---

## Tela 5: Dashboard de produtos

**Rota:** `/dashboards?…produtos` • **Capturas:** web 08, mobile 07.

### O que está errado hoje

- Um único cartão "Produtos ativos 157". Nada mais.

### O que fazer

1. Mais vendidos no período (quantidade e valor), top 10, com link para o produto.
2. Produtos sem venda no período.
3. Produtos com cadastro incompleto (sem foto, sem NCM, sem acabamentos) • hoje a maioria não tem foto na lista de produtos.
4. Produtos com saldo de estoque negativo ou zerado com pedido aberto.
5. Se nenhum desses dados estiver disponível, remover a tela do menu.

---

## Tela 6: Dashboard de clientes

**Rota:** `/dashboards?…clientes` • **Capturas:** web 09, mobile 08.

### O que está errado hoje

- Um único cartão "Clientes ativos 4".

### O que fazer

1. Top clientes por valor no período; clientes novos; clientes sem compra há mais de 90 dias.
2. Inadimplência por cliente (documento, seção 10: "inadimplência e prazo médio") quando houver títulos.
3. Distribuição por UF.
4. Se não houver dado, remover do menu.

---

## Tela 7: Curva ABC

**Rota:** `/dashboards?…abc` • **Capturas:** web 10, mobile 09.

### O que está errado hoje

- "Análise ainda indisponível". A justificativa ("requer uma base de faturamento por produto") está no subtítulo.

### O que fazer

- Remover do menu até existir faturamento por produto, **ou** calcular a curva com base em pedidos confirmados (deixando claro "por valor em pedidos, não faturamento"): classes A/B/C, % acumulado, gráfico de Pareto, tabela com produto, valor, % e classe.

---

## Tela 8: Metas

**Rota:** `/dashboards?…metas` • **Capturas:** web 11, mobile 10.

### O que está errado hoje

- "Metas ainda não cadastradas • O ERP ainda não possui cadastro de metas comerciais." O item existe no menu sem nenhum caminho para cadastrar.

### O que fazer

- Remover do menu enquanto não houver cadastro de metas.
- Quando existir: meta por vendedor e por mês, realizado, % atingido, projeção do mês; botão "Definir metas" para o gestor.

---

## Critérios comuns às telas de dashboard

- Mesmo cabeçalho (breadcrumb "Meu Negócio / Dashboard X", título, período, "Mais ações").
- Todo número clicável leva à lista de origem filtrada (substitui o link solto "Abrir registros de origem").
- Telas sem dado real saem do menu.
