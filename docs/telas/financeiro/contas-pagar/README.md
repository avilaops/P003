# Contas a pagar e pagamentos de funcionários

[Todas as telas](../../../README.md) · [Financeiro](../README.md)

Acompanhar obrigações a pagar e a área de pagamentos da equipe.

**Onde acessar:** `/financeiro/contas-pagar`, `/cadastros/funcionarios/pagamentos`.

## O que aparece na tela

- Favorecido, referência e vencimento
- Valor e situação
- Pagamento e conta conforme o fluxo
- Aba de funcionários

## O que você pode fazer

- Pesquisar e abrir uma obrigação
- Conferir o título de origem, a natureza, o centro de custo e a conta para o pagamento
- Registrar uma baixa individual ou em lote e acompanhar os itens que dependem de aprovação
- Conferir o principal abatido, os encargos e o líquido no extrato
- Estornar uma baixa com motivo e consultar o comprovante vinculado
- Acessar os pagamentos de funcionários

## Regras e limites

Registrar uma obrigação não executa transferência bancária. A área de funcionários não equivale a um cálculo completo de folha.

## Referências para manutenção

As ações disponíveis dependem das permissões do operador e da configuração da empresa.

- [FUNCIONARIOS-E-PAGAMENTOS](referencias/FUNCIONARIOS-E-PAGAMENTOS.md)
- [purchase-access](../../../../apps/web/src/features/purchasing/purchase-access.tsx)
- [payroll-workspace](../../../../apps/web/src/features/staff/payroll-workspace.tsx)
