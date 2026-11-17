# Melhorias: Grupos de produtos

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md) • [Componente compartilhado](../contas-financeiras/MELHORIAS.md#nota-sobre-o-componente-compartilhado)

**Rota:** `/cadastros/grupos-produtos` • **Código:** `apps/web/src/features/records/reference/reference-access.tsx` • **Capturas:** web 24.

## O que está errado hoje

- 0 grupos; estado vazio genérico.
- Nenhuma explicação da diferença entre **Grupo de produtos** e **Categoria de produtos** • o usuário não sabe qual usar.
- Item fixo no menu mesmo sem uso (documento, seção 8: reduzir o peso de funções raras).

## O que fazer

1. Decidir com o produto se grupos e categorias são conceitos distintos. Se forem iguais na prática, **unificar** em Categorias e remover esta tela.
2. Se forem distintos: estado vazio explicando ("Grupos juntam produtos para regras comerciais e relatórios, independentemente da categoria. Ex.: 'Linha Hammer', 'Lançamentos 2026'.") e botão "Novo grupo de produtos".
3. Mover para um submenu "Organização" ou para dentro de Produtos (aba), fora do primeiro nível do menu.
4. Colunas com registros: Nome, Produtos (contagem), Situação.

## Critérios de aceite

- O usuário entende pela própria tela quando usar grupo e quando usar categoria.
