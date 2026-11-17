# Melhorias: Categorias de produtos

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md) • [Componente compartilhado](../contas-financeiras/MELHORIAS.md#nota-sobre-o-componente-compartilhado)

**Rota:** `/cadastros/categorias-produtos` • **Código:** `apps/web/src/features/records/reference/reference-access.tsx` • **Capturas:** web 21.

## O que está errado hoje

- Duas categorias (CORE • Linha Core, PREMIUM • Linha Premium) com coluna **"Editar"** redundante (o nome já é link).
- O menu e o README falam em hierarquia/subcategorias, mas a lista é plana.
- Não mostra quantos produtos há em cada categoria (o catálogo tem 160).
- Botão "Novo cadastro", "2 registro(s)", "Consulta e edição", paginação de uma página.

## O que fazer

1. Botão primário "Nova categoria".
2. Colunas: Código, Nome, Produtos (contagem com link para Produtos filtrado), Situação. Sem "Editar".
3. Árvore quando houver subcategorias.
4. Ao arquivar categoria com produtos: avisar quantos produtos ficam sem categoria.

## Critérios de aceite

- Contagem por categoria bate com o filtro de Produtos.
- Sem coluna "Editar".
