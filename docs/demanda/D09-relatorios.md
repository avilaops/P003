# D09 • Relatórios: motor configurável e relatórios por área

## Objetivo

Fechar o módulo **Relatórios** (visão executiva, todos os relatórios, vendas, estoque, financeiro, serviços e auditoria), incluindo o motor de relatórios configuráveis.

## Telas do menu

| Grupo | Tela | Rota | Estado |
| --- | --- | --- | --- |
| (principal) | Visão executiva | `/relatorios/executivo` | Tela existente; completude a auditar |
| (principal) | Todos os relatórios | `/relatorios` | Tela existente; completude a auditar |
| (principal) | Vendas | `/relatorios/vendas` | Tela existente; completude a auditar |
| (principal) | Estoque | `/relatorios/estoque` | Tela existente; completude a auditar |
| (principal) | Financeiro | `/relatorios/financeiro` | Tela existente; completude a auditar |
| Operação | Serviços | `/relatorios/servicos` | Tela existente; completude a auditar |
| Operação | Auditoria | `/relatorios/auditoria` | Tela existente; completude a auditar |

## Backlog (itens da documentação de pendências)

Fonte: `docs/telas/pendencias/` e `docs/telas/<módulo>/`. Itens: G3.

### G3 • Motor de relatórios configuráveis

_Estado inicial: **a auditar**._

**Prioridade:** 90–180 dias (documento, seção 7.3) • **Referência:** TReport.

**Como desenvolver.** Uma fonte de dados declarada por relatório (consulta com filtros permitidos e checagem de permissão); usuário escolhe colunas, agrupamentos e totais; filtros salvos; exportação PDF, XLSX e CSV; agendamento por e-mail com histórico de execução. Os relatórios listados nos outros arquivos (Vendas V8, Estoque E9, Compras C8, Financeiro FI12, Serviços S3) usam este motor.

**Aceite.** Um relatório salvo com filtros é enviado por e-mail na periodicidade escolhida, com o arquivo e o registro da execução.

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

