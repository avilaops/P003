# Melhorias: Central de trabalho (Eventos, Notificações, Aplicativos, Novidades)

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md)

**Rotas:** `/eventos`, `/notificacoes`, `/aplicativos`, `/novidades` • **Código:** `apps/web/src/features/workspace/workspace-capability-unavailable.tsx`, menu em `apps/web/src/components/shell/navigation-catalog.ts` • **Capturas:** web 03 (Notificações), web 12 (Eventos), mobile 11.

## O que está errado hoje

- Quatro itens do menu "Central de trabalho" marcados "Indisponível" e todos abrem a mesma página "Funcionalidade indisponível" com 8 atalhos sem relação (Produtos, Clientes e fornecedores, Pedidos de venda, Pedidos de compra, Estoque, Contas a receber, Contas a pagar, Contratos).
- O sino de notificações no cabeçalho existe, mas a tela de notificações está indisponível.
- "Plano e limites" e "Assistente" ficam misturados com itens indisponíveis no mesmo grupo.

## O que fazer

1. **Remover do menu** Eventos, Aplicativos e Novidades enquanto indisponíveis (padrão comum).
2. **Notificações:** como o sino já está no cabeçalho, implementar a versão mínima útil **ou** esconder o sino. Versão mínima: lista das pendências do usuário (as mesmas do bloco "Precisa da sua atenção" da Visão geral • aprovações, propostas vencendo, títulos vencidos), com marcar como lida. Contador no sino.
3. **Página indisponível específica** (se a rota for acessada por link antigo): título com o nome da função ("Eventos"), uma frase do que fará, motivo de não estar ativa e um único atalho relacionado. Substituir o componente genérico por um que receba esses textos.
4. Reorganizar o grupo do menu: "Assistente" e "Plano e limites" em local coerente (Assistente junto da busca; Plano em Preferências).

## Mobile

- O mesmo: itens fora do menu; notificações em tela cheia ao tocar no sino.

## Critérios de aceite

- Nenhum dos quatro itens aparece no menu enquanto indisponível.
- O sino mostra contador real ou não aparece.
- Acesso direto a `/eventos` mostra página específica, sem a grade de 8 atalhos.
