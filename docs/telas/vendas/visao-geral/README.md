# Visão geral de vendas

[Todas as telas](../../../README.md) · [Vendas](../README.md)

Acompanhar propostas, pedidos e oportunidades comerciais da empresa.

**Onde acessar:** `/vendas`, `/vendas/funil`.

## O que aparece na tela

- Indicadores e registros recentes
- Valor das propostas em rascunho ou enviadas e dos pedidos criados no mês civil de São Paulo com os cancelados excluídos
- Conversão das propostas enviadas pela primeira vez nos últimos 90 dias e já vinculadas a um pedido
- Aprovações que seu perfil pode decidir, rascunhos parados há mais de sete dias e propostas enviadas já vencidas ou a até sete dias do vencimento

## O que você pode fazer

- Abrir propostas e pedidos
- Abrir um indicador para consultar seus registros de origem e conferir a soma ou a quantidade
- Criar e acompanhar oportunidades
- Seguir os atalhos para tabela e simulador

## Regras e limites

Uma oportunidade no funil não reserva estoque nem gera uma conta a receber.

## Referências para manutenção

Guia conferido no código de 12/11/2026. As ações dependem das permissões e da configuração da empresa. Relatos técnicos antigos descrevem a etapa em que foram escritos.

- [Consulta de indicadores](../../../../apps/api-ts/src/modules/sales/overview.ts)
- [Visão geral](../../../../apps/web/src/features/sales/sales-overview.tsx)
- [opportunities](../../../../apps/web/src/features/sales/opportunities.tsx)
