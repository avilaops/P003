# D10 • Preferências e plataforma SaaS: backlog

## Objetivo

Fechar **Preferências** e a camada de plataforma SaaS: parâmetros, fechamentos, onboarding, planos e limites, API pública e webhooks, exportação e backup, portais e status e versões.

## Telas do menu

| Grupo | Tela | Rota | Estado |
| --- | --- | --- | --- |
| Configurações | Visão geral das preferências | `/preferencias` | Tela existente; completude a auditar |
| Configurações | Empresa | `/preferencias` | Tela existente; completude a auditar |
| Configurações | Sistema | `/preferencias` | Tela existente; completude a auditar |
| Configurações | Cadastros | `/preferencias` | Tela existente; completude a auditar |
| Configurações | Suprimentos | `/preferencias` | Tela existente; completude a auditar |
| Configurações | Vendas | `/preferencias` | Tela existente; completude a auditar |
| Configurações | Notas Fiscais | `/preferencias` | Tela existente; completude a auditar |
| Configurações | Certificado Digital | `/preferencias` | Tela existente; completude a auditar |
| Configurações | Finanças | `/preferencias` | Tela existente; completude a auditar |
| Configurações | Serviços | `/preferencias` | Tela existente; completude a auditar |
| Configurações | Integrações | `/preferencias` | Tela existente; completude a auditar |
| Configurações | Logística | `/preferencias` | Tela existente; completude a auditar |
| Configurações | Contabilidade | `/preferencias` | Tela existente; completude a auditar |
| Configurações | Importações de Dados | `/preferencias` | Tela existente; completude a auditar |
| Configurações | Backup e Exportação de Dados | `/preferencias` | Tela existente; completude a auditar |

## Backlog (itens da documentação de pendências)

Fonte: `docs/telas/pendencias/` e `docs/telas/<módulo>/`. Itens: G5, G6, G7, G8, G9, G10, G11.

### G5 • Parâmetros centralizados

_Estado inicial: **a auditar**._

**Prioridade:** 90–180 dias • **Referência:** parâmetros `MV_*` e configurador.

**Como desenvolver.** Catálogo único de parâmetros (nome legível, módulo, tipo, padrão, valor por empresa, descrição do efeito, quem alterou e quando), exibido em Preferências com busca. Toda funcionalidade nova registra seus parâmetros aqui (padrão Protheus, princípio 4).

### G6 • Fechamentos e data limite

_Estado inicial: **a auditar**._

**Prioridade:** 90–180 dias. Painel "Fechamento do mês" que reúne Estoque E6, Financeiro FI9 e Fiscal F3/F4 com checklist, ordem recomendada e reabertura auditada.

### G7 • Onboarding e implantação

_Estado inicial: **a auditar**._

**Prioridade:** 90–180 dias (documento, seção 7.5).

**Como desenvolver.** Checklist de implantação por empresa (dados da empresa, certificado, contas financeiras, categorias, formas e condições de pagamento, produtos, clientes, usuários, tabela publicada) com progresso; importação assistida de produtos, clientes e saldos (ampliar a importação CSV atual para categoria, ficha técnica e acabamentos, como o guia já indica); dados de exemplo nunca misturados com os reais.

### G8 • Planos, assinatura e limites

_Estado inicial: **a auditar**._

**Prioridade:** 90–180 dias. Conectar a cobrança (Mercado Pago, já previsto na tela de Plano), medir consumo (dados, usuários, importações), avisar ao se aproximar do limite e bloquear de forma suave; plano atual e consumo visíveis (ver [prompt do Plano](../preferencias/empresa/MELHORIAS.md)).

### G9 • API pública e webhooks

_Estado inicial: **a auditar**._

**Prioridade:** 180–365 dias (documento, seção 7.4). Documentação pública do OpenAPI existente, chaves por aplicação com escopos (as chaves de serviço já existem), webhooks assinados com reenvio e log, ambiente de homologação, limites de uso.

### G10 • Exportação integral e backup do cliente

_Estado inicial: **a auditar**._

**Prioridade:** 90–180 dias. Exportar todos os dados da empresa (cadastros, documentos, XMLs, anexos) em formato aberto, sob demanda e agendado; o CSV de produtos atual não é backup integral (guia de Exportação).

### G11 • Portais de cliente e vendedor

_Estado inicial: **a auditar**._

**Prioridade:** 180–365 dias. Cliente: propostas para aceite, pedidos, notas, boletos e garantias. Vendedor externo: carteira, tabela publicada, simulador e pedidos no celular.

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

