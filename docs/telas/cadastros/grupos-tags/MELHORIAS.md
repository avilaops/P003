# Melhorias: Grupos de tags

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md) • [Tags](../tags/MELHORIAS.md)

**Rota:** `/cadastros/grupos-tags` • **Código:** `apps/web/src/features/records/reference/reference-access.tsx` • **Capturas:** web 25.

## O que está errado hoje

- 0 grupos; estado vazio genérico; tela separada de Tags embora os dois cadastros só façam sentido juntos.
- Dois itens de menu (Grupos de tags, Tags) para um conceito raro.

## O que fazer

1. **Unificar com Tags** numa única tela "Tags": grupos como seções e tags dentro de cada grupo, com criação inline ("+ Nova tag neste grupo", "+ Novo grupo"). A rota `/cadastros/grupos-tags` redireciona para `/cadastros/tags`.
2. Remover "Grupos de tags" do menu.

## Critérios de aceite

- Um único item "Tags" no menu; grupos gerenciados na mesma tela.
