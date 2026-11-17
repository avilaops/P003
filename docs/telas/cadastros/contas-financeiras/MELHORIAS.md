# Melhorias: Contas financeiras

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md)

**Rota:** `/cadastros/contas-financeiras` • **Código:** `apps/web/src/features/records/reference/reference-access.tsx` (componente compartilhado por 8 cadastros auxiliares • ver nota no fim) • **Capturas:** web 19, mobile 18.

## Objetivo

Cadastrar bancos, caixas e contas internas. Sem pelo menos uma conta, **Caixas e bancos** e o **PDV** não funcionam (web 55: "Nenhuma conta financeira ativa. Cadastre uma conta antes de lançar movimentos.").

## O que está errado hoje

- A empresa de exemplo tem **0 contas**, e a tela mostra só "Nenhum cadastro encontrado. Revise os filtros ou adicione um registro." • a mesma frase usada quando um filtro não encontra nada.
- Nenhuma explicação de que outras telas dependem deste cadastro.
- Botão "Novo cadastro" (genérico), "0 registro(s)", "Consulta e edição", paginação com uma página, filtros visíveis com a lista vazia.
- Card estreito centralizado no desktop.

## O que fazer

1. Título "Contas financeiras"; botão primário **"Nova conta financeira"**.
2. **Estado vazio de primeiro uso:** ícone, "Cadastre as contas onde o dinheiro da empresa entra e sai: banco, caixa ou conta interna. Elas são usadas em Caixas e bancos, no PDV e nos recebimentos.", botão "Cadastrar primeira conta". Esconder filtros e paginação neste estado.
3. Com registros: colunas Nome, Tipo (Banco / Caixa / Interna), Banco/agência/conta (mascarado parcialmente), Saldo atual (se disponível), Situação.
4. Atalho no detalhe da conta: "Ver movimentos" (Caixas e bancos filtrado).
5. No formulário de nova conta: tipo primeiro e campos condicionais (banco só pede agência/conta).

## Mobile

- Estado vazio centralizado com o botão em largura total.

## Critérios de aceite

- Com 0 contas, a tela explica a dependência e oferece a criação; não mostra filtros.
- Depois de criar uma conta, Caixas e bancos deixa de mostrar o aviso de conta ausente.

## Nota sobre o componente compartilhado

`reference-access.tsx` serve Contas financeiras, Categorias financeiras, Categorias de produtos, Formas de pagamento, Grupos de produtos, Grupos de tags, Tags e Depósitos. Faça as mudanças estruturais (cabeçalho, botão com nome do objeto, estado vazio de primeiro uso, ocultar paginação, remover "Consulta e edição" e coluna "Editar") **uma vez no componente**, recebendo por configuração: nome singular/plural, texto do estado vazio, dependências e colunas. Os prompts das outras telas listam só o que muda em cada uma.
