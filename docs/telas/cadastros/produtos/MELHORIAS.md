# Melhorias: Produtos (catálogo)

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md)

**Rota:** `/cadastros/produtos` • **Código:** `apps/web/src/features/catalog/catalog-access.tsx` e `catalog-workspace.tsx` • **Capturas:** web 16, mobile 15.

## Objetivo

Encontrar, conferir e manter rapidamente os 160 produtos da empresa, enxergando de cara o que está incompleto.

## O que está errado hoje

- "Novo produto" é um link pequeno no canto do card, não um botão primário.
- Busca só dispara com o botão "Buscar"; filtros de Categoria e Situação ficam soltos à direita.
- "160 produto(s) • Consulta e edição": contador com texto técnico.
- Quase todas as linhas mostram o **placeholder de foto** • não há como filtrar "sem foto".
- Nomes aparentemente duplicados lado a lado ("Agachamento Pêndulo" SKU-DE-EXEMPLO e "Agachamento Pendulum" SKU-DE-EXEMPLO) sem indicação de linha (nacional/importada).
- Produto **arquivado** aparece misturado com os ativos ("Agachamento V-Squat • Arquivado") porque o filtro padrão é "Todas".
- Colunas: Produto, SKU, Unidade, Preço base, Situação. Faltam Categoria e um indicador de cadastro completo; "Unidade" quase sempre "UN" ocupa uma coluna inteira.
- Linhas altas (miniatura de 40 px) • cabem ~10 produtos por tela.

## O que fazer

1. Cabeçalho padrão: "Produtos", botão primário "Novo produto", "Mais ações" (Importar, Exportar CSV).
2. Filtros: busca ao digitar (nome ou SKU), Categoria, Situação (padrão **Ativos**), e filtro "Cadastro" (Completo / Sem foto / Sem NCM / Sem acabamentos).
3. Colunas: Foto (32 px), Produto (nome + SKU em texto secundário), Categoria, Linha (se aplicável), Preço base, Situação (selo). Remover a coluna Unidade (mostrar só quando diferente de UN, junto do SKU).
4. **Indicador de completude**: ícone de alerta com tooltip ("Sem foto, sem NCM") nas linhas incompletas.
5. Ordenação por coluna (nome, SKU, preço).
6. Arquivados no fim ou ocultos pelo filtro padrão.
7. Preservar filtros e rolagem ao voltar do detalhe.
8. Paginação de 50 com total; ocultar quando uma página.
9. Ações em lote (opcional, fase 2): arquivar, mudar categoria.

## Mobile

- Já usa cartão (nome, SKU • UN • Ativo, preço). Manter, adicionar alerta de completude e mover Categoria/Situação para "Filtros" em bottom sheet; "Novo produto" como botão no cabeçalho.

## Critérios de aceite

- Filtro "Sem foto" lista os produtos sem imagem com contagem correta.
- Arquivados não aparecem na abertura da tela.
- 15 ou mais produtos visíveis por tela em 1280×800.
