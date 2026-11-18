# Implementação de Vendas • novembro de 2026

A implementação cobre as 15 entradas do [levantamento](LEVANTAMENTO-2026-11-17.md) e segue os critérios [V1 a V12](../pendencias/vendas.md). A interface usa Next.js, a API usa Fastify em TypeScript e o PostgreSQL mantém os saldos, as revisões e a trilha de auditoria. O n8n pode consumir eventos e fazer entregas pelos contratos do ERP.

## Operação comercial

| Entrada | Operação disponível | Evidência local |
| --- | --- | --- |
| Visão geral | Os indicadores abrem o conjunto que compõe o total. A conversão usa a coorte de propostas enviadas pela primeira vez nos últimos 90 dias. A fila respeita a alçada de quem consulta. | [API e coorte](../../../apps/api-ts/test/overview-postgres.test.ts) • [Navegação, contraste e zoom](../../../apps/web/tests/sales-overview-ui.spec.ts) |
| Funil comercial • V9 | Etapas configuráveis, responsável, atividade com prazo, perda justificada e vínculos com a proposta e o pedido. O operador pode voltar ao recorte de origem. | [Jornada no navegador](../../../apps/web/tests/sales-pipeline-ui.spec.ts) • [Configuração e atividades](../../../apps/api-ts/src/modules/opportunities/workspace.ts) |
| Tabela publicada • V6 | A gestão mantém custos, despesas e parâmetros, confere a prévia e publica por linha. O vendedor vê a disponibilidade por UF, sua alçada e a origem do preço por cliente, canal ou versão publicada. | [Publicação concorrente e recuperação](../../../apps/api-ts/test/price-publication-postgres.test.ts) • [Interface da tabela](../../../apps/web/tests/commercial-table-model-ui.spec.ts) • [Políticas exercitadas no banco](../../../apps/api-ts/test/sales-policies-postgres.test.ts) |
| Simulador | Transferência ao editor de pedido preserva equipamento, acabamento, base, condição e valores. Uma mudança na regra pede nova conferência mesmo com o mesmo resultado monetário. | [Transferência para o pedido](../../../apps/web/tests/commercial-flow-ui.spec.ts) |
| Propostas • V1 e V3 | Busca por documento, vendedor, validade e renovação. As condições podem ser reutilizadas e congeladas. A fila comercial aplica alçada e substituição antes da decisão. | [Listas comerciais](../../../apps/web/tests/sales-lists-ui.spec.ts) • [Condições e aprovações](../../../apps/api-ts/test/sales-policies-postgres.test.ts) |
| Pedidos de venda • V2, V4 e V5 | Do aceite à reserva, a API confere o crédito sem contar o título duas vezes. O faturamento parcial controla o saldo por item. A devolução parte do pedido ou da NF-e. Ela aceita o XML do cliente ou prepara uma NF-e própria de entrada para consumidor, vinculando a saída, quantidades, alçada, estoque, crédito e comissão. O detalhe também oferece PDF da revisão, anexos privados, baixa e estorno de títulos, comissão e cancelamento integral. | [Financeiro e documentos do pedido](../../../apps/api-ts/test/order-complements-postgres.test.ts) • [Disponibilidade por lote](../../../apps/api-ts/src/modules/fiscal-workspace/order-lot-state.ts) • [Entrada própria e efeitos por ambiente](../../../apps/api-ts/test/self-return-cases.ts) • [Alçada de devolução](../../../apps/api-ts/src/modules/fiscal-workspace/return-policy.ts) |
| PDV • V12 | A leitura distingue caixa fechado, conta ausente e falta de permissão. A preferência da empresa controla o acesso pelo menu, busca e endereço direto. | [Caixa e venda](../../../apps/web/tests/pos-ui.spec.ts) • [Preferência por empresa](../../../apps/web/tests/pos-visibility.spec.ts) |
| Fechamento do PDV | Seleção da sessão, conferência de recebimentos e movimentos, valor contado, diferença e fechamento. | [Jornada de caixa no navegador](../../../apps/web/tests/pos-ui.spec.ts) |
| Histórico do PDV | Pesquisa de sessões, retorno ao fechamento escolhido, recuperação de falha e apresentação do primeiro uso. | [Histórico e navegação](../../../apps/web/tests/pos-ui.spec.ts) |
| Garantias • V10 | O protocolo identifica nota, item, série ou lote, política e prazo. O detalhe reúne fila, SLA, responsável, OS, peças, quarentena, laudos, termos, RMA e resolução financeira. Evidências privadas ficam vinculadas à empresa e ao protocolo. | [Banco e fluxos do protocolo](../../../apps/api-ts/test/warranty-cases.ts) • [Navegador até PostgreSQL](../../../apps/web/tests/warranty-integrated-ui.spec.mjs) |

## Canais, análise e documentos fiscais

| Entrada | Operação disponível | Evidência local |
| --- | --- | --- |
| Importar pedidos • V11 | Modelo CSV, mapeamento, prévia, confirmação e resultado por linha. A identidade do pedido usa empresa, canal e número externo. Loja e Anúncios usam entregas com confirmação do conector. | [Importação no navegador](../../../apps/web/tests/order-import-ui.spec.ts) • [Entrega e confirmação pelo canal](../../../apps/api-ts/test/channel-service-postgres.test.ts) |
| Relatórios de vendas • V7 e V8 | Vendedor, canal e período acompanham a consulta de origem. Valor pedido, faturado e recebido usam suas respectivas datas. Metas, curva ABC, margem prevista e realizada, exportação e impressão respeitam o recorte e o perfil. | [Bases e metas de vendas](../../../apps/api-ts/src/modules/commercial/performance.ts) • [Políticas e perfis](../../../apps/api-ts/test/sales-policies-postgres.test.ts) |
| NF-e | Lista por modelo, situação e ambiente, preparação, consulta, XML, DANFE, e-mail, eventos e reconciliação de resposta incerta. As notas de uma venda parcial permanecem vinculadas ao pedido. | [Operações fiscais](../../../apps/api-ts/src/modules/fiscal-workspace) • [Lotes no navegador](../../../apps/web/tests/fiscal-order-lots-ui.spec.ts) |
| NFC-e | Modelo 65 consultável separadamente. A prontidão depende de série, ambiente, CSC e certificado. O motor gera o QR e o DANFE térmico de acordo com o ambiente configurado. | [Motor fiscal TypeScript](../../../apps/fiscal-engine) • [Consulta e prontidão por modelo](../../../apps/api-ts/src/modules/fiscal-workspace/outgoing.ts) |
| Notas fiscais de entrada | Importação do XML, distribuição com cursor, manifestação e conciliação com compra. O recebimento físico explícito gera os movimentos de estoque e contas a pagar. Repetições recuperam a operação original. | [Entrada e recebimento](../../../apps/api-ts/src/modules/fiscal-incoming) • [Interface de recebimento](../../../apps/web/tests/fiscal-incoming-ui.spec.ts) |

## O que acontece entre as telas

1. A oportunidade identifica o cliente e o responsável. A proposta congela sua versão e suas condições. O pedido mantém a referência comercial, as parcelas e a origem do preço de cada item. [Proposta e pedido](../../../apps/api-ts/src/modules/orders/snapshot.ts)
2. O aceite avalia o crédito e gera os títulos. A reserva movimenta o estoque. Cada lote faturado registra seus itens, notas e entregas para que faturar ou devolver parte do pedido tenha efeitos proporcionais. [Crédito](../../../apps/api-ts/src/modules/commercial/credit.ts) • [Lotes fiscais](../../../apps/api-ts/src/modules/fiscal-workspace/order-lots.ts)
3. O pós-venda recupera nota, pedido, produto e prazo a partir da identificação da unidade. As baixas, estornos, devoluções e liquidações de garantia consultam o saldo do mesmo pedido. [Rastreio de série e lote](../../../apps/api-ts/test/warranty-policy-trace-postgres.test.ts) • [Liquidação de garantia](../../../apps/api-ts/test/warranty-settlement-postgres.test.ts)
4. A API confere empresa, permissão, revisão e chave de idempotência nos comandos que alteram saldos. O conector entrega eventos e confirma o recebimento. Uma credencial de canal tem escopo de empresa e canal. O n8n pode executar o transporte. [Contrato do canal](../../../apps/api-ts/src/modules/commercial/channel-service.ts) • [Teste do conector](../../../apps/api-ts/test/channel-service-postgres.test.ts)

## Densidade da lista de pedidos

Com 25 pedidos e perfil com edição, o Chromium mediu as linhas inteiras visíveis antes de rolar a página. A largura do documento coincidiu com a largura da janela nos três tamanhos. [Capturas com as medidas](pedidos-densidade-2026-11-18.pdf) • [Medição repetível](../../../apps/web/tests/sales-density-ui.spec.ts)

| Janela | Linhas completas em 17/11 | Linhas completas em 18/11 | Altura da primeira linha em 18/11 |
| --- | ---: | ---: | ---: |
| 1366 × 768 | 3 | 6 | 57 px |
| 1920 × 1080 | 5 | 12 | 57 px |
| 390 × 844 | 2 | 2 | 137 px |

## Verificação e ambientes

A suíte integrada abriu uma garantia pelo Chromium, alterou a fila e recarregou o detalhe. Ela conferiu os eventos de auditoria e a revisão persistida no PostgreSQL, anexou evidência, baixou o conteúdo privado e consultou os indicadores da assistência. O teste percorre a sessão web, o BFF e o Fastify. A identidade e as empresas são sintéticas. [Teste integrado](../../../apps/web/tests/warranty-integrated-ui.spec.mjs)

As simulações fiscais exercitam autorização, rejeição, consulta e recuperação com transporte controlado. A homologação oficial do modelo 55 já documentada no projeto é independente da execução local desta implementação. A ativação de cada ambiente, credencial de canal, e-mail e operação fiscal externa requer evidência própria. [Levantamento e fontes oficiais do projeto](LEVANTAMENTO-2026-11-17.md)

A ativação no estabelecimento depende dos dados da empresa, das credenciais dos serviços e da homologação pela UF e perfil fiscal. O piloto comercial conserva os custos nacionais pendentes de LD-WH065 e LD-WH066 e as exclusões de modelos acordadas no Linear. [Escopo comercial AVL-432](https://linear.app/avilaops/issue/AVL-432) • [Registro fiscal AVL-328](https://linear.app/avilaops/issue/AVL-328)
