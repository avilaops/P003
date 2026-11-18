# Estoque e saldos

[Todas as telas](../../../README.md) • [Estoque](../README.md) • [Levantamento da tela 41](LEVANTAMENTO-TELA-41.md)

Consultar o estoque dos produtos da empresa.

**Onde acessar:** `/estoque`, `/estoque/saldos`.

## O que aparece na tela

- **Produto, SKU e unidade** identificam cada linha. **Saldo** é a quantidade física. **Reservado** reúne as reservas de vendas e de componentes de produção. **Disponível** é a diferença entre saldo e reservado.
- **Valor** mostra o saldo valorizado. Uma entrada cujo custo ainda precisa ser informado aparece como **A apurar**. A grade aceita quantidades fracionárias na unidade do cadastro.

## O que você pode fazer

- Busque por nome ou SKU. Com o controle por depósito habilitado, selecione o depósito. Marque **Somente produtos com saldo físico positivo** para localizar os itens presentes.
- Use **Ver movimentos** na linha do SKU. O Kardex leva o período, as entradas, as saídas, os documentos de origem e os pedidos em aberto. Ao voltar, a grade recupera a busca, o depósito, a página e o foco do produto.

## Regras e limites

A consulta abre na empresa ativa. Em **Todos os depósitos**, uma transferência interna preserva a quantidade total. A confirmação do pedido reserva a quantidade. A saída física é registrada em outro movimento.

## Referências para manutenção

As telas 40 e 41 compartilham a grade. A consulta e a movimentação têm permissões próprias.

- [ESTOQUE-PERSISTENTE](referencias/ESTOQUE-PERSISTENTE.md)
- [stock-access](../../../../apps/web/src/features/inventory/stock-access.tsx)
