# Ordens de produção

[Todas as telas](../../../README.md) · [Estoque](../README.md)

Preparar e acompanhar as ordens de produção disponíveis no ERP.

**Onde acessar:** `/estoque/ordens-producao`.

## O que aparece na tela

- Produto e quantidade
- Ordem, situação e execução

## O que você pode fazer

- Consultar as ordens no quadro por etapa e preparar a ordem de um pedido.
- Salvar a versão da estrutura do produto, conferir o consumo previsto e reservar os componentes.
- Apontar a quantidade produzida, perdas, tempo e custos adicionais. Conferir o movimento de entrada do produto acabado no Kardex.

## Regras e limites

A ordem usa a versão da estrutura vinculada na preparação. O apontamento consome componentes e registra a entrada do acabado na mesma transação. A correção de custo de componentes repercute no produto acabado. O detalhe comercial do pedido sinaliza ordens abertas em atraso.

## Referências para manutenção

Guia conferido no código de 12/11/2026. As ações dependem das permissões e da configuração da empresa. Relatos técnicos antigos descrevem a etapa em que foram escritos.

- [COMISSOES-PRODUCAO-E-FISCAL](referencias/COMISSOES-PRODUCAO-E-FISCAL.md)
- [production-workspace](../../../../apps/web/src/features/production/production-workspace.tsx)
