# D08 • Serviços: backlog

## Objetivo

Fechar o módulo **Serviços** (contratos, modelos, ordens de serviço, CT-e, notas de serviço e cobranças).

## Telas do menu

| Grupo | Tela | Rota | Estado |
| --- | --- | --- | --- |
| Operação | Visão geral | `/servicos` | Tela existente; completude a auditar |
| Operação | Contratos | `/servicos/contratos` | Tela existente; completude a auditar |
| Operação | Modelos de contratos | `/servicos/contratos/modelos` | Tela existente; completude a auditar |
| Operação | Ordens de serviço | `/servicos/ordens` | Tela existente; completude a auditar |
| Operação | CT-e | `/servicos/cte` | Tela existente; completude a auditar |
| Operação | Notas de serviço | `/servicos/notas` | Tela existente; completude a auditar |
| Operação | Cobranças | `/servicos/cobrancas` | Tela existente; completude a auditar |

## Backlog (itens da documentação de pendências)

Fonte: `docs/telas/pendencias/` e `docs/telas/<módulo>/`. Itens: S1, S2, S3.

### S1 • Contrato com faturamento recorrente

_Estado inicial: **a auditar**._

**Prioridade:** 90–180 dias • **Referência:** gestão de contratos com medição e cronograma financeiro.

**Como desenvolver.** Contrato com vigência, valor, periodicidade, reajuste (índice e data-base), itens de serviço; cronograma de faturamento gera NFS-e (Fiscal F6) e títulos a cada período; aditivos versionados; alerta de vencimento e de reajuste.

**Aceite.** Contrato mensal gera a nota e o título do mês na data do cronograma, sem intervenção manual.

### S2 • Ordens de serviço

_Estado inicial: **a auditar**._

**Prioridade:** 90–180 dias. OS com cliente, equipamento/série, técnico, agenda, checklist, horas, peças consumidas (baixa de estoque), fotos e assinatura do cliente no celular; fechamento gera cobrança (quando fora da garantia) e histórico do equipamento.

### S3 • Relatórios de serviços

_Estado inicial: **a auditar**._

**Prioridade:** 90–180 dias. Contratos a vencer, receita recorrente mensal, OS por técnico e por SLA, no motor de relatórios.

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

