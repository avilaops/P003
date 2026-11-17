# Melhorias: Categorias financeiras

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md) • [Componente compartilhado](../contas-financeiras/MELHORIAS.md#nota-sobre-o-componente-compartilhado)

**Rota:** `/cadastros/categorias-financeiras` • **Código:** `apps/web/src/features/records/reference/reference-access.tsx` • **Capturas:** web 20, mobile 19.

## O que está errado hoje

- 0 categorias na empresa de exemplo; estado vazio genérico, igual ao de filtro sem resultado.
- Lista plana, embora o cadastro aceite subcategorias (ver README): não há como ver a árvore receita → despesa → subcategoria.
- Botão "Novo cadastro", "0 registro(s)", "Consulta e edição", coluna "Editar" (nas outras telas do mesmo componente).

## O que fazer

1. Botão primário "Nova categoria financeira".
2. **Estado vazio com modelo pronto:** "Organize receitas e despesas para os relatórios e o DRE." + botões "Usar modelo padrão" (cria um plano básico: Receitas de vendas, Serviços; Despesas com pessoal, Impostos, Fornecedores, Frete, Administrativas) e "Criar do zero". Confirmar antes de criar em lote.
3. Exibição em **árvore** com dois grupos (Receitas / Despesas), expandir/recolher, contagem de subcategorias.
4. Mover/reordenar categorias (fase 2).

## Critérios de aceite

- Com 0 categorias, o usuário consegue criar o plano padrão em 2 cliques, com confirmação.
- Subcategorias aparecem aninhadas sob a categoria pai.
