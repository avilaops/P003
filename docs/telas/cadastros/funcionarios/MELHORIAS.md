# Melhorias: Funcionários

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md)

**Rota:** `/cadastros/funcionarios` • **Código:** `apps/web/src/features/staff/staff-access.tsx` • **Capturas:** web 18, mobile 17.

## O que está errado hoje

- Título "Equipe cadastrada" ≠ menu "Funcionários"; botão "Novo cadastro" como link no canto.
- Sem filtro por cargo/função (vendedor, gerente), que é a principal distinção usada em comissões e alçadas.
- Vendedor e gerente aparecem iguais; não há selo de "Vendedor ativo" ou de perfil de alçada.
- "4 cadastro(s) • Consulta e edição"; paginação com uma página.
- No celular, e-mails quebram no meio ("equipe.comercial / @example.test").

## O que fazer

1. Título "Funcionários"; botão primário "Novo funcionário".
2. Filtros: busca ao digitar (nome, código, cargo), Cargo, Situação (padrão Ativos).
3. Colunas: Código, Nome, Cargo (selo "Vendedor" destacado), Perfil comercial/alçada (Vendas, Gerência, Diretoria • se vier do usuário vinculado), Contato.
4. Indicar funcionário sem usuário de acesso vinculado, quando relevante para vendas.
5. Link "Ver comissões" por vendedor (leva a Financeiro → Comissões filtrado).

## Mobile

- Cartão com nome, cargo em selo, código; contato truncado.

## Critérios de aceite

- Filtrar "Vendedor" mostra 3 pessoas na empresa de exemplo; gerente identificado visualmente.
