# Melhorias: Contas a pagar

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md)

**Rota:** `/financeiro/contas-pagar` • **Código:** `apps/web/src/features/purchasing/purchase-access.tsx` (`view="payables"`), `apps/web/src/features/staff/payroll-workspace.tsx` • **Capturas:** web 53.

## O que está errado hoje

- As abas "Contas e pagamentos | Pagamentos de funcionários" ficam **acima** do breadcrumb e do título, separadas do conteúdo.
- 0 contas; estado vazio com texto correto, mas sem estrutura (resumo, filtros) e sem ação de lançar uma conta avulsa (aluguel, serviço) se o fluxo permitir.
- Ação de topo "Consultar compras" como única.

## O que fazer

1. Cabeçalho padrão com título "Contas a pagar" e as abas **abaixo** do título.
2. Mesmo modelo de Contas a receber: resumo por vencimento (vencido, hoje, 7 dias, 30 dias), colunas (Vencimento, Fornecedor/funcionário, Origem • compra, folha, despesa fixa —, Parcela, Valor, Situação), filtros, "Registrar pagamento", estorno com motivo, total e exportação.
3. Se o produto permitir despesa avulsa, botão "Nova conta a pagar"; senão, estado vazio dizendo de onde vêm (compras confirmadas, folha, despesas fixas em Preferências) com links.

## Critérios de aceite

- Abas abaixo do título; estrutura igual à de Contas a receber.
