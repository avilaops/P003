# Lançamentos de estoque

[Todas as telas](../../../README.md) • [Estoque](../README.md)

Em `/estoque/lancamentos`, consulte as entradas e saídas de todos os produtos da empresa. A consulta abre com os últimos 30 dias, em ordem decrescente de data efetiva.

## Consultar um movimento

1. Ajuste **Data inicial** e **Data final**. Use **Direção do movimento** para ver apenas entradas ou saídas. Quando a empresa controla saldos por depósito, o filtro **Depósito** permite escolher o local.
2. Para restringir a consulta a um SKU, digite o código ou o nome em **Buscar produto ou SKU** e escolha o item em **Produto**. **Limpar filtros** restaura o período padrão e a consulta de todos os produtos.
3. Confira cada linha pela data efetiva, SKU, produto, unidade, depósito, entrada ou saída e motivo. A coluna **Tipo de origem** identifica a operação. Em **Documento de origem**, abra o vínculo disponível para consultar a transferência, o inventário, a ordem de produção ou o documento comercial correspondente. Um lançamento manual sem documento aparece como **Sem documento vinculado**.

## Conferir o Kardex e exportar

Com um produto selecionado, use **Consultar Kardex do produto** para conferir os saldos de abertura e fechamento, as reservas e os movimentos do período. Também é possível abrir **Selecionar produto para consultar o Kardex** e escolher um SKU na lista. **Voltar à consulta** recupera os filtros da consulta geral.

Use **Exportar CSV completo** ou **Visualizar impressão/PDF** para obter todos os registros dos filtros aplicados. **Consultar atividade de movimentação** mostra o volume de entradas e saídas agrupado por data, depósito e unidade.

## Registrar ou estornar um lançamento manual

O perfil com permissão de movimentação tem acesso a **Novo lançamento**. Se necessário, selecione o produto. Informe direção, quantidade e motivo. Escolha o depósito quando o controle por local estiver ativo. Para produtos com rastreio, informe os números de série solicitados. Confirme o lançamento e confira o saldo no histórico do produto.

Para desfazer um lançamento manual elegível, abra **Novo lançamento** para o produto, localize o movimento no histórico, use **Preparar estorno**, informe o motivo e confirme. O estorno mantém a referência ao movimento original.

## Referências para manutenção

[Consulta de lançamentos](../../../../apps/web/src/app/estoque/lancamentos/page.tsx) • [Novo lançamento](../../../../apps/web/src/app/estoque/lancamentos/novo/page.tsx)
