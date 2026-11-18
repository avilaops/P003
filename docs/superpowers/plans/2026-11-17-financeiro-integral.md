# Financeiro • implementação e aceite local

A entrega está na branch `feat/financeiro-integral-ts` e incorpora a revisão `bdd8dca9` da main, inclusive o envio de documentos financeiros pelo n8n. O [levantamento funcional](../../telas/financeiro/LEVANTAMENTO-2026-11-17.md) registra a referência TOTVS Protheus, a situação inicial das seis telas e os itens associados no Linear.

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

• [Carteira e operações em PostgreSQL](../../../apps/api-ts/test/finance-portfolio.test.ts) • 105 títulos, baixa parcial, limite, vencidos, projeção sem duplicar pedidos, estornos, alçada, adiantamentos e bloqueio do período financeiro.

• [Baixas, compras e folha](../../../apps/api-ts/test/finance-wallets.test.ts) • encargos, comprovantes, lote, isolamento entre empresas e originação das obrigações.

• [Aceite bancário completo em Chromium](../../../apps/web/tests/finance-treasury-persistence.spec.ts) • navegador, BFF e API reais, PostgreSQL descartável e instituição HTTP local. Duas parcelas somam R$ 100. A tarifa é R$ 2 e o crédito líquido é R$ 98. A conciliação vincula uma linha de extrato a três lançamentos. O teste confere os IDs das parcelas e os centavos no banco.

• [Gestão e contabilidade](../../../apps/api-ts/test/finance-management.test.ts) • regras por evento, comissões, pendências, partidas dobradas, revisões e estornos.

Para repetir as suítes da API, defina `API_TS_TEST_ADMIN_URL` com uma instância PostgreSQL descartável que permita criar e remover bancos de teste. Execute `pnpm --filter api-ts test`. Para os testes bancários no navegador utilize a mesma instância e `pnpm --filter web exec playwright test --config playwright.finance-treasury.config.ts`. O arquivo de teste especifica as portas de loopback e o provedor local.

## Pendências externas

A empresa confirmou em 18 de novembro de 2026 que ainda não configurou uma conta de teste do Mercado Pago ou da Efí. A integração de cobrança para o piloto é Mercado Pago por API. A Efí pode fornecer o extrato CNAB 240 segmento E para a conciliação. A remessa e o retorno de cobrança por arquivo dependem do convênio e do leiaute contratado. O aceite bancário externo deve registrar o identificador de uma cobrança Pix e de um boleto no ambiente de testes, a confirmação do provedor e o líquido conciliado. [Configuração e roteiro de homologação](../../telas/financeiro/caixas-bancos/OPERACAO-BANCARIA.md)

O responsável financeiro deve conferir o mapeamento das naturezas e o contador deve aprovar as regras de débito e crédito da empresa antes do fechamento oficial. A revisão da implementação foi solicitada em branch local.
