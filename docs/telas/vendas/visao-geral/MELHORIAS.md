# Melhorias: Vendas (visão geral) e Funil comercial

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md)

---

## Tela 1: Vendas • visão geral

**Rota:** `/vendas` • **Código:** `apps/web/src/features/sales/sales-workspace.tsx` • **Capturas:** web 27.

### O que funciona

É a melhor visão geral do ERP: indicadores, lista de pedidos e de propostas com ação por linha. Manter a estrutura.

### O que está errado hoje

- Indicadores só de quantidade em rascunho ("4 Pedidos em rascunho", "2 Propostas em rascunho"); nenhum valor, nenhuma conversão.
- Botões por linha inconsistentes: "Abrir" para cancelado/rascunho recente e "Continuar" para outros rascunhos, sem regra visível.
- Pedido **cancelado** (PV-EXEMPLO) aparece na lista principal entre os rascunhos.
- Pedidos em rascunho antigos (PV-EXEMPLO de 30/10) sem alerta de parado; propostas de 08/11 e 11/11 vencidas sem destaque.
- Três ações no topo ("Tabela de preços", "Novo orçamento", "Novo pedido" + seta) e o termo **"Novo orçamento"** abre Propostas • nome diferente para a mesma coisa.
- Valores alinhados à direita longe do nome do cliente; colunas largas e vazias.

### O que fazer

1. Indicadores (4): Valor em propostas abertas, Pedidos do mês (valor), Aguardando aprovação (quantidade), Conversão proposta → pedido nos últimos 90 dias.
2. Bloco "Precisa de ação": rascunhos parados > 7 dias, propostas vencidas/vencendo, pedidos aguardando aprovação • com o botão certo ("Continuar", "Renovar validade", "Aprovar").
3. Listas recentes sem cancelados por padrão; ação por linha com uma regra: rascunho → "Continuar"; demais → "Abrir".
4. Unificar vocabulário: **"Nova proposta"** (ou "Novo orçamento" em todo o produto • escolher um). Ações do topo: primário "Novo pedido", secundário "Nova proposta", "Tabela de preços" em link.
5. Selos de status coloridos e coluna "Vendedor".

### Critérios de aceite

- PV-EXEMPLO e as duas propostas vencidas aparecem em "Precisa de ação" com a data.
- Mesmo termo para proposta em toda a área de vendas.

---

## Tela 2: Funil comercial

**Rota:** `/vendas/funil` • **Código:** `apps/web/src/features/sales/opportunities.tsx`, `opportunity-pipeline-model.ts` • **Capturas:** web 28.

### O que está errado hoje

- Funil exibido como **lista**, sem colunas por etapa.
- "Resumo da empresa" em acordeão recolhido mostrando "0 em andamento • R$ 0,00".
- Texto técnico "0 oportunidade(s) no filtro • 0 nesta página"; paginação com uma página.
- Estado vazio sem explicar o fluxo (Lead → Proposta → Pedido, documento seção 4).

### O que fazer

1. **Visão kanban** por etapa (padrão no desktop), com total de valor e quantidade por coluna; arrastar entre etapas com confirmação e registro de data/usuário. Alternar para lista.
2. Resumo sempre visível no topo (em andamento, valor, conversão), não em acordeão.
3. Cartão da oportunidade: empresa, contato, valor estimado, dias na etapa, próxima atividade; ações "Criar proposta" e "Marcar como perdida (motivo)".
4. Estado vazio: "Registre os contatos com potenciais clientes e acompanhe até virar proposta e pedido." + "Nova oportunidade".
5. Filtros: vendedor, etapa, período.

### Mobile

- Kanban vira lista agrupada por etapa (cabeçalhos recolhíveis) com mudança de etapa por menu.

### Critérios de aceite

- Etapas visíveis como colunas no desktop; mover oportunidade registra histórico.
