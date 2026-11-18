# Financeiro • implementação e aceite local

A entrega está na branch local `feat/financeiro-integral-ts`, com a revisão `655ecfa4` da main como base de integração. O envio por n8n mantém a personalização dos e-mails. No cancelamento de venda concluída, o estorno financeiro preserva juros, rateios e comissões ao reverter os efeitos no estoque e na produção. O [levantamento funcional](../../telas/financeiro/LEVANTAMENTO-2026-11-17.md) registra a referência TOTVS Protheus, a situação inicial das seis telas e os itens associados no Linear.

## O que conferir no ERP

| Entrega | Caminho na interface | Critério de conferência |
| --- | --- | --- |
| FI1 e FI2 • baixa e classificação | Financeiro • Contas a receber ou Contas a pagar • abrir título | Uma baixa de R$ 400 de principal e R$ 10 de juros em um título de R$ 1.000 deixa R$ 600 em aberto e movimenta R$ 410. O estorno referencia a baixa, recupera o saldo e gera contrapartida. Conferir natureza, centro, comprovante e alçada. |
| FI3 e FI12 • fluxo e resultado | Financeiro • Relatórios financeiros | A carteira, o CSV, a impressão e o relatório por e-mail usam a seleção completa. O fluxo usa data do movimento e saldo por vencimento. A DRE usa competência e discrimina juros e tarifas de cobrança. O saldo consolidado elimina transferências internas. |
| FI4 e FI9 • tesouraria | Financeiro • Caixas e bancos e Controle de caixa | Importar o extrato, conferir data, valor e referência, confirmar o vínculo e fechar o período. O fechamento da conta e a data limite da empresa têm escopos diferentes. Conferir abertura, sangria, suprimento, contagem e justificativa do caixa físico. |
| FI5 e FI10 • cobrança | Financeiro • Faturamento agrupado, depois Remessas e retornos | Agrupar parcelas de pelo menos dois pedidos do cliente, definir vencimento, emitir uma cobrança e conferir a distribuição por parcela. Reprocessar a confirmação conserva a baixa original. |
| FI6 a FI8 • parceiro e operações | Financeiro • Ficha financeira | Conferir limite, posição, atrasos e origens. Um adiantamento atribuído ao pedido é aplicado ao faturar a venda ou receber a compra. Compensações não movimentam novamente o caixa. A renegociação mantém os títulos originais e registra juros, substitutos, decisão e estorno. |
| FI11 • comissões | Financeiro • Comissões | Conferir a política preservada em cada pedido, o evento de faturamento ou recebimento, o ajuste por devolução e o título a pagar do fechamento. |
| FI13 • contabilidade | Financeiro • Contador | Configurar plano e regras, conferir pendências, lançar os eventos e fechar a competência. Comparar diário, razão, balancete e documento de origem. |

## Evidência reproduzível

O aceite integrado de tesouraria inicia o navegador, o BFF, a API TypeScript e o PostgreSQL. A rota de identidade da empresa também usa TypeScript. As contrapartes HTTP do banco e do n8n são locais, o que permite conferir a cobrança, a repetição dos eventos e os bytes do PDF entregue sem usar contas externas.

• [Carteira e operações em PostgreSQL](../../../apps/api-ts/test/finance-portfolio.test.ts) • 105 títulos, baixa parcial, limite, vencidos, projeção sem duplicar pedidos, estornos, alçada, adiantamentos e bloqueio do período financeiro.

• [Baixas, compras e folha](../../../apps/api-ts/test/finance-wallets.test.ts) • encargos, comprovantes, lote, isolamento entre empresas e originação das obrigações.

• [Atualização de uma base existente](../../../apps/api-ts/test/finance-upgrade.test.ts) • as migrações rodam sobre uma carteira com baixa parcial anterior. O título mantém os R$ 600 em aberto e a baixa antiga continua sem classificação bancária. A segunda execução das migrações preserva os registros.

• [Borderô por conta](../../../apps/api-ts/test/finance-collection-batches.test.ts) • títulos de clientes diferentes, valor e vencimento conferidos antes da emissão, cancelamento, concorrência e rastreio das liquidações.

• [Cobrança por arquivo Santander 240](../../../apps/api-ts/test/treasury-collection-file-cases.ts) • o teste gera a remessa, importa confirmações, rejeições e pagamentos, reabre o período e verifica reavaliações concorrentes, estornos e isolamento por empresa. No [cenário em Chromium](../../../apps/web/tests/finance-treasury-persistence.spec.ts), o usuário baixa a remessa de R$ 40,00 e importa o retorno. A API registra uma baixa, R$ 2,00 de tarifa e R$ 38,00 líquidos mesmo após repetir a importação.

• [Boleto no simulador HTTP](../../../apps/api-ts/test/treasury-boleto-cases.ts) • endereço do pagador, vencimento, recuperação de uma emissão após perda da resposta e confirmação repetida. Um boleto de R$ 60,20 gera uma baixa e um crédito de R$ 60,20.

• [Aceite bancário completo em Chromium](../../../apps/web/tests/finance-treasury-persistence.spec.ts) • navegador, BFF e API reais, PostgreSQL descartável e instituição HTTP local. Duas parcelas somam R$ 100. A tarifa é R$ 2 e o crédito líquido é R$ 98. A conciliação vincula uma linha de extrato a três lançamentos. O teste confere os IDs das parcelas e os centavos no banco.

• [Gestão e contabilidade](../../../apps/api-ts/test/finance-management.test.ts) • regras por evento, comissões, pendências, partidas dobradas, revisões e estornos.

• [Cobranças e conciliação](../../../apps/api-ts/test/finance-treasury.test.ts) • importação OFX e CNAB de extrato, tarifa identificada no banco, vínculos únicos, correspondências ambíguas, congelamento da conta e retornos duplicados.

Para repetir as suítes da API, defina `API_TS_TEST_ADMIN_URL` com uma instância PostgreSQL descartável que permita criar e remover bancos de teste. Execute `pnpm --filter api-ts test`.

Para reproduzir o aceite no navegador com a versão compilada, execute `pnpm --filter web build`, defina `ERP_FINANCE_BROWSER_PRODUCTION=1` e mantenha a instância de teste em `API_TS_TEST_ADMIN_URL`. Execute em sequência `pnpm --filter web exec playwright test --config playwright.wallet.config.ts` e `pnpm --filter web exec playwright test --config playwright.finance-treasury.config.ts`. As configurações iniciam o ERP nas portas locais de cada suíte. Defina `ERP_BROWSER_CHANNEL=chrome` para usar o Chrome instalado.

O envio por e-mail tem uma suíte adicional. Execute `pnpm --filter web exec playwright test --config playwright.commercial-documents.config.ts finance-email-bff.spec.ts finance-email-ui.spec.ts` usando o mesmo build. O teste da prévia rejeita filtros desconhecidos e chaves repetidas e preserva os filtros da carteira. O teste da tesouraria lê o texto do PDF recebido pelo transporte local e procura cada um dos 105 identificadores.

## Resultado do aceite local em 18 de novembro de 2026

Na revisão de aplicação `4eda831c`, que integra o Financeiro com estoque e produção, passaram os 115 testes da API e os 15 testes de arquitetura. As três suítes Playwright passaram sem repetição ou teste pulado • 9 de tesouraria e gestão, 28 de carteiras, compras e folha e 15 de documentos financeiros e envio. A API e a web compilaram, a verificação de tipos da API passou e o ESLint aceitou os 64 arquivos TypeScript de web alterados em relação à base.

Os relatórios JSON do Chromium ficam em `artifacts/danfe-browser/financeiro-256-tesouraria/report.json`, `artifacts/danfe-browser/financeiro-256-carteiras/report.json` e `artifacts/danfe-browser/financeiro-256-documentos/report.json` na cópia de trabalho. A rodada de tesouraria manteve o serviço legado fora do caminho do teste.

O catálogo da revisão `d2770c2a` inclui as rotas financeiras e seus destinos no BFF. Passaram as 29 verificações de contratos, descoberta de rotas e contexto de produto. Para repetir, execute `node --test verification/test/contracts.test.mjs verification/test/product-context.test.mjs verification/test/discovery.test.mjs`.

Com o [fluxo n8n de extrato Efí](../../integrations/n8n-financeiro-extrato-efi.json), os 116 testes da API passaram, sem falhas ou testes pulados. O verificador do n8n aceitou os 13 nós. O [teste de importação](../../../apps/api-ts/test/efi-workflow-cases.ts) executou a lógica do fluxo contra a API do ERP com PostgreSQL e um extrato de exemplo. Duas importações do mesmo arquivo devolveram o mesmo protocolo e uma única linha de R$ 100,00. O ERP rejeitou o arquivo endereçado à conta incorreta.

Na conciliação por documento (FI4), passaram os 117 testes da API e os nove cenários de tesouraria e gestão no Chromium. Entre 13 movimentos com a mesma data e valor, a referência exata apareceu primeiro e a linha continuou pendente até a revisão. Quando as duas fontes informaram documentos divergentes, a importação preservou a pendência mesmo com um único candidato.

Com a cobrança Santander por arquivo, o Chromium passou nos 54 cenários de Financeiro • 11 de tesouraria e gestão, 28 de carteiras, compras e folha e 15 de documentos e envio. Os relatórios ficam em `artifacts/danfe-browser/financeiro-cnab-final-{tesouraria,carteiras,documentos}/report.json`. O cenário isolado de remessa e retorno também gravou um arquivo `.REM` e dois arquivos `.RET` em `artifacts/danfe-browser/financeiro-cnab240-validado/test-results/`. Os três arquivos são fictícios.

A suíte final passou nos 125 testes da API com PostgreSQL, sem testes pulados. A regressão do retorno `06` cobre crédito futuro em conferência e reavaliação na data efetiva. O catálogo passou nas 29 verificações de contratos, descoberta e contexto. As 15 verificações de arquitetura passaram, e o verificador da estrutura confirmou as 532 rotas de páginas, layouts e BFF.

## Pendências externas

A empresa confirmou em 18 de novembro de 2026 que ainda não configurou uma conta de teste do Mercado Pago ou da Efí. O piloto usa a API do Mercado Pago. O aceite externo deve registrar a emissão de Pix e boleto, a consulta de cada identificador e a recepção de uma notificação de teste. Os relatórios oficiais de teste do Mercado Pago vêm sem movimentações. O exemplo com tarifa e líquido pode ser repetido com a instituição local, e a conferência de um extrato real depende de habilitação posterior. [Configuração e homologação](../../telas/financeiro/caixas-bancos/OPERACAO-BANCARIA.md) • [Relatórios de teste do Mercado Pago](https://www.mercadopago.com.br/developers/pt/docs/reports/account-money/introduction)

A Efí disponibiliza a API de extratos usada na conciliação. O borderô também gera remessa de cobrança e recebe retorno Santander CNAB 240, com base no manual público H7815 v8.5. O [roteiro por arquivo](../../telas/financeiro/caixas-bancos/OPERACAO-BANCARIA.md#integrar-cobrança-por-remessa-e-retorno-cnab) explica como testar com uma conta fictícia no ERP. Para a transmissão oficial, a empresa deverá selecionar a instituição e homologar o convênio e o canal de troca.

O responsável financeiro deve conferir o mapeamento das naturezas e o contador deve aprovar as regras de débito e crédito da empresa antes do fechamento oficial. A revisão da implementação foi solicitada em branch local.
