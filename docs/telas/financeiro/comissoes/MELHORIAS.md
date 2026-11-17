# Melhorias: Comissões

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md)

**Rota:** `/financeiro/comissoes` • **Código:** `apps/web/src/features/finance/commissions-workspace.tsx` • **Capturas:** web 58.

## O que está errado hoje

- **Sem título de página**; a tela começa com o acordeão "▸ Ver indicadores • 2026-11" (mês em formato técnico).
- Dois cartões de total (Saldo em aberto R$ 0,00, Pagamentos declarados R$ 0,00) e um cartão por vendedor com botão de rótulo longo "Consultar comissões de Vendedor de Exemplo".
- Cartões por vendedor ocupam muito espaço e não permitem comparar; o gerente comercial não aparece • confirmar se é regra (só vendedores) e dizer isso.
- Paginação com uma página.

## O que fazer

1. Cabeçalho padrão: "Comissões", seletor de competência ("Novembro de 2026", não "2026-11").
2. Indicadores sempre visíveis (não em acordeão): Comissão gerada no mês, Em aberto, Paga, Vendedores com comissão.
3. **Tabela por vendedor**: Vendedor, Pedidos, Base de cálculo, Comissão, Paga, Em aberto, ação "Ver detalhe" (botão curto). Linha de total.
4. Detalhe do vendedor: pedidos, % aplicado, ajustes (a API tem `commissions/{id}/adjustments`) e pagamentos com data e usuário.
5. Ação "Registrar pagamento" em lote para a competência.
6. Nota explicando quem entra na lista (ex.: "Funcionários com cargo Vendedor").

## Critérios de aceite

- Título e competência legível; tabela comparável com total; botões curtos.
