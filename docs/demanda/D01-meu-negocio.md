# D01 • Meu Negócio: dashboards e central de trabalho

## Objetivo

Fechar o módulo **Meu Negócio**: os 7 dashboards (geral, vendas, margem por pedido, produtos, clientes, curva ABC e metas) com dados reais, e a central de trabalho (eventos, notificações, aplicativos, assistente, novidades e plano e limites). Eventos, Notificações, Aplicativos e Novidades **nunca foram iniciadas**.

## Telas do menu

| Grupo | Tela | Rota | Estado |
| --- | --- | --- | --- |
| (principal) | Dashboard geral | `/dashboards` | Disponível (rota dinâmica `/dashboards/[kind]`); conteúdo e dados reais a auditar |
| (principal) | Dashboard de vendas | `/dashboards/vendas` | Disponível (rota dinâmica `/dashboards/[kind]`); conteúdo e dados reais a auditar |
| (principal) | Margem por pedido | `/dashboards/margem-pedidos` | Disponível (rota dinâmica `/dashboards/[kind]`); conteúdo e dados reais a auditar |
| (principal) | Dashboard de produtos | `/dashboards/produtos` | Disponível (rota dinâmica `/dashboards/[kind]`); conteúdo e dados reais a auditar |
| (principal) | Dashboard de clientes | `/dashboards/clientes` | Disponível (rota dinâmica `/dashboards/[kind]`); conteúdo e dados reais a auditar |
| (principal) | Curva ABC | `/dashboards/curva-abc` | Disponível (rota dinâmica `/dashboards/[kind]`); conteúdo e dados reais a auditar |
| (principal) | Metas | `/dashboards/metas` | Disponível (rota dinâmica `/dashboards/[kind]`); conteúdo e dados reais a auditar |
| Central de trabalho | Eventos | `/eventos` | **Indisponível: nunca iniciada**, só pré-visualização (`demonstration-routes.ts`) |
| Central de trabalho | Notificações | `/notificacoes` | **Indisponível: nunca iniciada**, só pré-visualização (`demonstration-routes.ts`) |
| Central de trabalho | Aplicativos | `/aplicativos` | **Indisponível: nunca iniciada**, só pré-visualização (`demonstration-routes.ts`) |
| Central de trabalho | Assistente | `/assistente` | Tela existente; completude a auditar |
| Central de trabalho | Novidades | `/novidades` | **Indisponível: nunca iniciada**, só pré-visualização (`demonstration-routes.ts`) |
| Central de trabalho | Plano e limites | `/preferencias/plano` | Tela existente; completude a auditar |

## Backlog (itens da documentação de pendências)

Fonte: `docs/telas/pendencias/` e `docs/telas/<módulo>/`. Itens: G1, G2, G4, G12.

### G1 • Painel de pendências e próxima ação

_Estado inicial: **a auditar**._

**Prioridade:** 0–90 dias (documento, seção 9.1, item 6).

**Como desenvolver.** Serviço que agrega, por usuário e permissão: aprovações (Vendas V1, Compras C3), pedidos parados, propostas vencendo, títulos vencidos, pendências de configuração (conta financeira, certificado, categorias). Exibido na Visão geral e no sino de notificações. Cada item com link para a lista filtrada e ação direta quando possível.

**Aceite.** Cada pendência leva à lista com o mesmo total; itens resolvidos somem sem recarregar a página.

### G2 • Notificações e eventos (workflow)

_Estado inicial: **a auditar**._

**Prioridade:** 90–180 dias • **Referência:** workflow e eventos do sistema.

**Como desenvolver.** Assinatura de eventos de domínio (`outbox_events`) por usuário/papel: no app (sino), e-mail e WhatsApp (já há canal de operação); preferências por tipo de evento; linha do tempo de eventos da empresa (substitui `/eventos` e `/notificacoes` indisponíveis).

### G4 • Dashboards com dados reais

_Estado inicial: **a auditar**._

**Prioridade:** 0–90 dias. Conforme o [prompt dos dashboards](../inicio/visao-geral/MELHORIAS.md): só exibir no menu dashboards com dados; os demais dependem de V7 (metas), V8 (margem e ABC).

### G12 • Status, suporte e versões

_Estado inicial: **a auditar**._

**Prioridade:** 90–180 dias. Página de status dos serviços (SEFAZ, banco, e-mail), central de ajuda integrada ao assistente, política de versões com "Novidades" (substitui `/novidades`), canal de suporte com contexto da tela.

## Primeira tarefa (antes de codar)
Auditar **cada item do backlog contra o código** (`apps/web`, `apps/api-ts`, `apps/api`) e marcar na descrição deste PR, com evidência (arquivo ou teste):
- **Concluído**: já atende o aceite do item.
- **Parcial**: o que existe e o que falta.
- **Pendente**: nada foi feito.

O estado de cada item hoje é **desconhecido**: a documentação de pendências é anterior às entregas de 17 e 18/11 e várias já podem estar prontas.

## Como entregar
- Telas em `apps/web`, regras e rotas em `apps/api-ts` (TypeScript). **Nenhum código novo em `apps/api` (Rust)**: ele será removido (ver PR 11, #292).
- Escrever **testes novos**: os atuais não estão completos. Rotas com teste de sucesso, acesso negado, entrada inválida e conflito; telas com jornada em Playwright quando houver fluxo.
- Um commit por item, para poder revisar e reverter por item.
- `pnpm --filter api-ts typecheck`, `pnpm --filter api-ts test` e o CI do `web` verdes antes de pedir revisão.
- O sistema ainda não está em produção: não é preciso manter compatibilidade nem fazer migração gradual.

## Critério de aceite do PR
Todos os itens marcados **Concluído** (com evidência) ou explicitamente adiados com justificativa na descrição.

