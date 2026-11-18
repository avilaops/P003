# Depósitos

[Todas as telas](../../../README.md) • [Estoque](../README.md)

Cadastrar os locais usados no controle de estoque.

**Onde acessar:** `/estoque/depositos`.

## O que aparece na tela

- Código e nome
- Localização, situação e observação

## O que você pode fazer

- Buscar, cadastrar e editar depósitos
- Arquivar ou reativar conforme os vínculos
- Abrir um depósito e escolher **Ver saldos do depósito** para consultar os produtos com saldo físico positivo naquele local. A grade mostra SKU, unidade, saldo, reservado e disponível. Esse atalho exige acesso de leitura ao estoque e controle de saldos por depósito ativo.

## Regras e limites

Em **Transferências entre depósitos**, configure o uso de depósitos e os padrões de venda, compra e produção. A posição de abertura recebe o saldo consolidado anterior. O vínculo com cada documento indica o depósito efetivo da operação. Clique na quantidade de produtos de um depósito para consultar os SKUs com saldo físico positivo.

Cada transferência registra uma saída na origem e uma entrada no destino na mesma transação. O estorno desfaz as duas pontas e verifica o disponível no destino.

## Referências para manutenção

Guia conferido no código de 12/11/2026. As ações dependem das permissões e da configuração da empresa. Relatos técnicos antigos descrevem a etapa em que foram escritos.

- [reference-workspace](../../../../apps/web/src/features/records/reference/reference-workspace.tsx)
