# Estoque

[Todas as telas](../../README.md)

Escolha a tela que deseja consultar. Novo cadastro, consulta e edição ficam no mesmo guia da listagem.

| Tela | Para que serve |
| --- | --- |
| [Estoque e saldos](saldos/README.md) | Consultar o estoque dos produtos da empresa. |
| [Lançamentos de estoque](lancamentos/README.md) | Consultar movimentações e registrar um lançamento manual autorizado. |
| [Conferência de estoque](inventarios/README.md) | Conferir o fluxo de inventário e contagem disponível na empresa. |
| [Ordens de produção](producao/README.md) | Preparar e acompanhar as ordens de produção disponíveis no ERP. |
| [Depósitos](depositos/README.md) | Cadastrar os locais usados no controle de estoque. |
| [Relatórios de estoque](https://erp.avilaops.com/relatorios/estoque) | Consultar movimentos, conferências, produção, saldos e indicadores conforme as permissões da empresa. |

## Custos, rastreabilidade e reposição

- **Custos e fechamento mensal** • Em `/estoque/fechamento`, confira a base das entradas, o frete e os impostos recuperáveis. A saída usa o custo médio ponderado do depósito. O fechamento verifica contagens em aberto, recálculos e custos pendentes antes de gravar os saldos da competência. A reabertura exige permissão e motivo.
- **Números de série** • Em `/estoque/series`, busque a identificação de um equipamento pelo teclado ou leitor. O histórico apresenta o depósito e os documentos da unidade. O pedido e a NF-e de origem permitem consultar as séries vinculadas.
- **Reposição** • Em `/compras/sugestoes`, consulte a necessidade de compra por produto. O cálculo considera pedidos aceitos em aberto, mínimo, disponível e compras em aberto. O ponto de pedido, o lote e o prazo do fornecedor fazem parte da regra do SKU.

## Relatórios, gráficos e filtros

- **Movimentos** • Consulte entradas e saídas por data efetiva, depósito e unidade. Selecione um SKU ou uma direção para investigar o volume. Abra o Kardex quando precisar do documento que originou um lançamento.
- **Conferências** • Acompanhe as linhas contadas e pendentes de cada inventário aberto no período, inclusive os que já foram aprovados ou cancelados. Use a situação para restringir a lista. Consulte divergências e acurácia para avaliar o resultado das contagens aprovadas.
- **Produção** • Compare as ordens abertas no período por etapa e situação atual. A tabela identifica o produto acabado, a unidade e a quantidade planejada. Filtre por produto ou depósito para consultar uma parte da operação.
- **Posição e planejamento** • Consulte posição valorizada, giro e cobertura, itens parados e classificação ABC. Cada análise indica a data de referência e o critério de cálculo.

O catálogo oferece apenas as análises autorizadas. Os gráficos identificam o recorte apresentado. O CSV completo e a visualização de impressão/PDF em **Análises de estoque** incluem todas as linhas dos filtros aplicados.
