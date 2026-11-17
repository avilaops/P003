# Melhorias: PDV (Frente de caixa, Fechamento, Histórico)

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md)

**Rotas:** `/vendas/pdv`, `/vendas/pdv/fechamento`, `/vendas/pdv/historico` • **Código:** `apps/web/src/features/pos/pos-access.tsx` • **API:** `GET /api/v1/pos/sessions` e `GET /api/v1/pos/sessions/current` • **Capturas:** web 33, 34, 35.

## Diagnóstico confirmado

Em 17/11/2026, para a empresa de exemplo, **`GET /api/v1/pos/sessions` e `GET /api/v1/pos/sessions/current` responderam HTTP 500 ("Erro interno")**. As três telas exibem só "Erro interno" + "Consultar novamente". A empresa de exemplo também não tem nenhuma conta financeira cadastrada, o que provavelmente está relacionado (o caixa do PDV depende de conta).

## O que está errado hoje

- **Bug de backend:** a API devolve 500 em vez de um erro de negócio (ex.: 409/422 "Cadastre uma conta financeira para abrir o caixa").
- A tela mostra "Erro interno" sem causa nem caminho.
- Links "Frente de caixa • Fechamento do caixa • Histórico dos caixas" duplicam os três itens do menu.
- Campo "Caixa: Principal" + "Consultar caixa" sem explicar o que acontece.
- O histórico tem filtros (caixa, situação, abertura de/até) visíveis mesmo com erro.
- Para a empresa de exemplo (venda técnica de equipamentos), o PDV é função rara e ocupa três itens de primeiro nível no menu de Vendas.

## O que fazer

1. **Backend (prioridade):** reproduzir o 500, corrigir a causa e devolver erro de negócio tipado quando faltar pré-requisito (conta financeira, caixa, permissão). Teste cobrindo empresa sem conta financeira.
2. **Pré-requisitos na tela:** se faltar conta financeira ou caixa, mostrar "Para usar o PDV, cadastre uma conta financeira do tipo Caixa." + botão "Cadastrar conta" (leva a Cadastros → Contas financeiras com o tipo pré-selecionado).
3. Erro inesperado: mensagem simples + "Tentar de novo" + "Detalhes técnicos" (request id).
4. Remover a navegação duplicada; usar abas no cabeçalho (Frente de caixa / Fechamento / Histórico) **ou** só o menu.
5. Esconder filtros do histórico quando não há dados ou houve erro.
6. **Menu:** agrupar as três telas num único item "PDV" (com abas) e permitir ocultar o PDV por configuração da empresa quando não usado.

## Critérios de aceite

- Nenhum 500 nas rotas de sessão do PDV para empresa sem conta financeira; a tela mostra o pré-requisito e o atalho.
- Um único item "PDV" no menu.
