# Melhorias: Histórico importado

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md)

**Rota:** `/historico` • **Código:** `apps/web/src/features/data/legacy/legacy-history.tsx` • **Capturas:** web 02, mobile 02.

## Objetivo

Permitir consultar os registros trazidos do sistema anterior (clientes, cores, pedidos, documentos) para tirar dúvidas e conferir a migração, sem confundir com o cadastro atual.

## O que está errado hoje

- 1.048 registros numa lista única de acordeões, sem busca, sem paginação visível e sem agrupamento.
- Títulos com dado cru: **"Empresa - true"** (booleano exposto), "Clientes - CLIENTE DE EXEMPLO", "Cores - Piano Black".
- Registros aparentemente duplicados ("Cores - Graphite Black" aparece duas vezes) sem indicar a diferença.
- O select "Tipo de registro" mostra o texto cortado/sobreposto (no desktop e no celular).
- Link "Cadastro atual de produtos" solto acima do filtro, sem contexto.
- Cada item precisa ser aberto para saber o que contém.

## O que fazer

1. **Cabeçalho:** título "Histórico importado", descrição "Registros do sistema anterior, somente leitura. O cadastro atual fica em Cadastros." e a data da importação.
2. **Resumo por tipo** em chips com contagem (Clientes 120 • Cores 18 • Pedidos 640 …); clicar filtra.
3. **Busca** por texto em todos os campos, com debounce.
4. **Tabela** (não acordeão) com colunas: Tipo, Identificação (nome legível), Data no sistema anterior, Vínculo atual (link para o cadastro atual quando houver correspondência, ex.: cliente já migrado). Detalhe abre em painel lateral com todos os campos em formato chave/valor legível.
5. **Título legível por tipo:** para "Empresa", usar razão social; nunca exibir `true/false` • booleanos viram "Sim/Não".
6. Duplicados: mostrar o campo que difere ou agrupar com "2 registros".
7. Paginação de 50 itens e exportar CSV.
8. Corrigir o select cortado (altura de linha/padding do `select`).

## Mobile

- Chips de tipo com rolagem horizontal; lista de cartões (tipo em selo, nome, data); detalhe em tela cheia.

## Critérios de aceite

- Nenhum título contém `true`, `false`, `null` ou UUID.
- Buscar "Mantovani" encontra o cliente em menos de 1 s.
- Select legível nos dois temas.
