# Visão geral financeira

[Todas as telas](../../../README.md) · [Financeiro](../README.md)

Acessar recebíveis, pagamentos e consultas financeiras.

**Onde acessar:** `/financeiro`.

## O que aparece na tela

- Saldos internos por conta, valores a receber e a pagar, vencidos e agenda dos próximos sete dias
- Vínculos dos indicadores com os títulos do filtro e data de corte da empresa

## O que você pode fazer

- Abrir as contas a receber e a pagar
- Consultar os movimentos autorizados

## Regras e limites

Os indicadores dependem dos registros consultados e das permissões da empresa.

## Relatórios financeiros

Em `/relatorios/financeiro`, confira a carteira por parceiro, natureza, lado e faixa de atraso. Os totais, a impressão, o CSV e o PDF enviado por e-mail consideram todos os títulos do filtro. A data de corte indica quais baixas entram na posição. Uma baixa programada pode deixar saldo na posição de hoje e reduzir o valor disponível para uma nova baixa.

O fluxo de caixa separa os movimentos realizados das projeções por data. A DRE gerencial usa a competência dos lançamentos. Confira o período e o critério de cada relatório ao comparar seus totais.

## Referências para manutenção

As ações disponíveis dependem das permissões do operador e da configuração da empresa.

- [finance-overview](../../../../apps/web/src/features/finance/finance-overview.tsx)
