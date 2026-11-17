# Melhorias: Formas de pagamento

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md) • [Componente compartilhado](../contas-financeiras/MELHORIAS.md#nota-sobre-o-componente-compartilhado)

**Rota:** `/cadastros/formas-pagamento` • **Código:** `apps/web/src/features/records/reference/reference-access.tsx` • **Capturas:** web 23.

## O que está errado hoje

- Códigos internos da migração expostos: **`LEGACY-1` … `LEGACY-12`**.
- "Boleto" **arquivado** aparece no topo (ordenação por código), misturado aos ativos.
- Coluna "Editar" redundante.
- Não mostra o que importa para o vendedor e o financeiro: se aceita parcelamento, prazo, taxa, se gera título a receber, conta financeira de destino.
- Nomes parecidos sem distinção clara ("Cartão de crédito" e "Cartão de crédito (presencial)"; "Link de pagamento - cartão de crédito").

## O que fazer

1. Botão primário "Nova forma de pagamento".
2. Colunas: Nome, Modalidade (À vista / Parcelado / Na entrega), Parcelas máx., Conta de destino, Situação. Código interno só no detalhe, e renomeável.
3. Ordenar por nome; arquivados ocultos por padrão (filtro "Ativos").
4. Agrupar por modalidade (Dinheiro e PIX, Cartões, Boleto, Outros) quando houver mais de 8.
5. Migração: oferecer renomear `LEGACY-n` para códigos legíveis (ex.: `PIX`, `BOLETO`) • sem alterar documentos antigos.

## Critérios de aceite

- Nenhum `LEGACY-` visível na lista.
- Boleto arquivado só aparece com o filtro "Arquivados" ou "Todas".
