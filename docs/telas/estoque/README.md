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

## Custos, rastreabilidade e reposição

- **Custos e fechamento mensal** • Em `/estoque/fechamento`, confira a base das entradas, o frete e os impostos recuperáveis. A saída usa o custo médio ponderado do depósito. O fechamento verifica contagens em aberto, recálculos e custos pendentes antes de gravar os saldos da competência. A reabertura exige permissão e motivo.
- **Números de série** • Em `/estoque/series`, busque a identificação de um equipamento pelo teclado ou leitor. O histórico apresenta o depósito e os documentos da unidade. O pedido e a NF-e de origem permitem consultar as séries vinculadas.
- **Reposição** • Em `/compras/sugestoes`, consulte a necessidade de compra por produto. O cálculo considera pedidos aceitos em aberto, mínimo, disponível e compras em aberto. O ponto de pedido, o lote e o prazo do fornecedor fazem parte da regra do SKU.
- **Relatórios** • Em `/relatorios/estoque/analises`, consulte posição valorizada, Kardex, giro e cobertura, itens parados, divergências, acurácia e classificação ABC. A análise apresenta os critérios da fonte, os filtros aplicáveis e as opções de exportação.
