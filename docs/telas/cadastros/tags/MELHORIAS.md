# Melhorias: Tags

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md) • [Componente compartilhado](../contas-financeiras/MELHORIAS.md#nota-sobre-o-componente-compartilhado)

**Rota:** `/cadastros/tags` • **Código:** `apps/web/src/features/records/reference/reference-access.tsx` • **Capturas:** web 26.

## O que está errado hoje

- 0 tags; estado vazio genérico; não diz onde as tags são usadas (clientes? pedidos? produtos?).
- Tela separada de Grupos de tags.

## O que fazer

1. Tela única "Tags" com grupos como seções (ver [Grupos de tags](../grupos-tags/MELHORIAS.md)).
2. Estado vazio: "Tags marcam clientes, produtos e pedidos para filtrar e segmentar. Ex.: 'Academia premium', 'Revenda'." + "Criar primeira tag".
3. Cada tag com cor, nome, grupo e contagem de uso (onde aplicada), com link para a lista filtrada.
4. Mover para "Organização" no menu (segundo nível).

## Critérios de aceite

- A tela explica onde a tag é usada; contagem de uso visível.
