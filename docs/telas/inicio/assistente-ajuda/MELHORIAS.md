# Melhorias: Assistente do ERP

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md)

**Rota:** `/assistente` • **Código:** `apps/web/src/features/assistant/erp-assistant-module.tsx` • **Capturas:** web 13, mobile 12.

## Objetivo

Responder perguntas sobre produtos, estoque, clientes e pedidos da empresa ativa e levar o usuário à tela certa.

## O que está errado hoje

- Coluna estreita centralizada no desktop, com a área de conversa vazia ocupando metade da tela.
- Bloco de aviso longo ("Somente consultas. As fontes mostram dados confirmados pelo ERP conforme suas permissões. A conversa fica nesta tela e é processada na infraestrutura da Avila Ops.") antes da conversa.
- Nome da empresa repetido em destaque azul abaixo do título (já está no cabeçalho).
- Nenhuma sugestão de pergunta; o usuário não sabe o que pode pedir.
- O botão "Enviar" parece desabilitado mesmo como estado normal.
- Volta "← Início" diferente do resto do produto.

## O que fazer

1. Layout de conversa em largura útil (máx. 880 px), campo de mensagem fixo no rodapé da área.
2. **Sugestões clicáveis** quando a conversa está vazia: "Qual o saldo do Banco Reto?", "Pedidos em rascunho desta semana", "Clientes de SP", "Onde cadastro uma conta financeira?".
3. Aviso de privacidade em uma linha discreta abaixo do campo, com "Saiba mais".
4. Respostas com links para os registros e telas citados (abrir no mesmo contexto).
5. Indicador "Consultando…" durante a resposta; erro com "Tentar de novo".
6. Atalho de teclado: Enter envia, Shift+Enter quebra linha. Integrar com a busca `Ctrl K` ("Perguntar ao assistente: …").
7. Botão "Enviar" com estado desabilitado apenas quando o campo está vazio.

## Mobile

- Campo de mensagem fixo acima do teclado; sugestões em chips com rolagem horizontal; aviso recolhido.

## Critérios de aceite

- Conversa vazia mostra pelo menos 4 sugestões.
- Respostas citam o registro com link funcional.
