# Melhorias: Caixas e bancos

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md)

**Rota:** `/financeiro/caixas-bancos` • **Código:** `apps/web/src/features/finance/financial-account-ledger.tsx` • **Capturas:** web 55, `reports/screens/mobile/financeiro__caixas-bancos.png`.

## O que está errado hoje

- A tela inteira é **uma frase** sem título: "Nenhuma conta financeira ativa. Cadastre uma conta antes de lançar movimentos." Não há botão nem link para cadastrar.
- No menu existe "Caixa" (indisponível) e "Caixas e bancos" • nomes que confundem.

## O que fazer

1. Cabeçalho padrão: "Caixas e bancos", descrição "Saldo e movimentos de cada conta financeira."
2. Sem contas: estado vazio com ícone, a frase atual e botão **"Cadastrar conta financeira"** (leva ao cadastro e volta para cá ao salvar).
3. Com contas: seletor/abas de conta com saldo atual; extrato (Data, Descrição, Origem com link, Entrada, Saída, Saldo); filtros de período; "Novo lançamento" (entrada/saída/transferência entre contas, a API já tem `financial/account-transfers`); conciliação manual (marcar conferido) • documento seção 9.2, item 1.
4. Renomear o item indisponível "Caixa" (controle de caixa) ou retirá-lo do menu (ver [Outros recursos](../outros-recursos/MELHORIAS.md)).

## Critérios de aceite

- Sem contas: título, explicação e botão de cadastro.
- Com uma conta criada, extrato e saldo visíveis.
