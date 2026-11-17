# Melhorias: Listas de preços

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md)

**Rota:** `/cadastros/listas-precos` • **Código:** `apps/web/src/features/price-lists/price-lists-access.tsx` • **Capturas:** web 22.

## O que está errado hoje

- Um terceiro padrão de lista: "Nova lista" é link **fora** do card (canto superior direito da página), botão chama "Pesquisar" (nas outras é "Buscar"), sem "Limpar", sem título dentro do card.
- Cabeçalho da tabela (Código, Nome, Situação, Vigência, Produtos) aparece mesmo vazio, com "Nenhuma lista encontrada." abaixo.
- 0 listas; nenhuma explicação da diferença entre **Lista de preços** (cadastro manual) e **Tabela publicada** (Vendas, calculada a partir de custos e política) • o README da tela diz que são separadas, a tela não.

## O que fazer

1. Cabeçalho padrão: título "Listas de preços", botão primário "Nova lista de preços".
2. Estado vazio: "Listas de preços servem para preços combinados por canal ou cliente, com vigência. A tabela comercial calculada fica em Vendas → Tabela publicada." + "Criar primeira lista" + link "Abrir tabela publicada".
3. Padrão de lista único (busca ao digitar, "Limpar filtros" só com filtro ativo, sem cabeçalho de tabela vazio).
4. Com registros: Nome, Canal/cliente, Vigência (início–fim, selo "Vigente"/"Expirada"/"Futura"), Produtos (contagem), Situação.

## Critérios de aceite

- Mesmo padrão visual das outras listas de cadastro.
- A tela deixa explícita a diferença para a Tabela publicada.
