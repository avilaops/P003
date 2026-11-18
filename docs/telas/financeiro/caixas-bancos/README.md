# Caixas e bancos

[Todas as telas](../../../README.md) · [Financeiro](../README.md)

Consultar contas financeiras e o extrato interno disponível no ERP.

**Onde acessar:** `/financeiro/caixas-bancos`.

## O que aparece na tela

- Conta financeira
- Período e lançamentos

## O que você pode fazer

- Selecionar a conta
- Consultar os movimentos e saldos exibidos

## Regras e limites

O saldo interno vem dos movimentos da conta. O último saldo informado pelo banco e o total dos movimentos conciliados aparecem com suas referências. Para conferir uma diferença, abra a linha importada, vincule os lançamentos correspondentes ou registre a classificação do movimento. [Importação, conciliação e fechamento](OPERACAO-BANCARIA.md)

## Referências para manutenção

As ações disponíveis dependem das permissões do operador e da configuração da empresa.

- [financial-account-ledger](../../../../apps/web/src/features/finance/financial-account-ledger.tsx)
