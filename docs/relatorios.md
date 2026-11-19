# Motor de relatórios configuráveis (G3)

Dono: PR #301 [D09]. Código: `apps/api-ts/src/modules/reports/engine/`. Telas: `/relatorios/configuraveis` e `/relatorios/configuraveis/{id}`.

O usuário escolhe **fonte, colunas, agrupamento (até 2), totais (soma, média, mínimo, máximo) e filtros**. Ele salva a definição, exporta em **CSV, XLSX ou PDF** e agenda o **envio por e-mail** (diário, semanal ou mensal) com **histórico de execução** e o arquivo enviado. Ninguém escreve SQL: cada fonte declara o que pode ser escolhido, e o motor recusa o resto com 422.

## Como declarar uma fonte nova (agentes de área: V8, E9, C8, FI12, S3)

1. Crie `apps/api-ts/src/modules/reports/engine/sources/<fonte>.ts` com `defineSource({...})`. Use como modelo [`sales-orders.ts`](../apps/api-ts/src/modules/reports/engine/sources/sales-orders.ts) ou [`audit-log.ts`](../apps/api-ts/src/modules/reports/engine/sources/audit-log.ts).
2. Acrescente a fonte à lista em [`registry.ts`](../apps/api-ts/src/modules/reports/engine/registry.ts). **Não precisa de migração**: a definição salva grava as permissões da fonte (`required_permissions`), e a política RLS usa essa coluna.
3. Escreva um teste com o helper `test/support/` (veja `test/report-engine.test.ts`), com sucesso, 403 sem a permissão da fonte e 422 para filtro não declarado.

```ts
export const minhaFonte = defineSource({
  id: "purchase_orders",            // ^[a-z][a-z0-9_]{0,62}$, único
  label: "Compras por período", area: "compras",
  description: "Pedidos de compra emitidos no período.",
  permissions: ["<permissão da área>"],      // exemplo; TODAS são exigidas (tela, definição salva e envio agendado)
  columns: {
    supplier: { label: "Fornecedor", type: "text", groupable: true },
    amount:   { label: "Valor (R$)", type: "money", aggregatable: true },
  },
  filters: {
    period: { kind: "period", label: "Emissão", required: true },  // presets relativos: mês anterior, últimos 30 dias...
    status: { kind: "choice", label: "Situação", options: { open: "Aberto" } },
  },
  defaultColumns: ["supplier", "amount"],
  async load(ctx, filters, limit) {
    const { from, to } = filters.period as { from: string; to: string }
    return (await ctx.client.query(`SELECT ... FROM purchase_orders WHERE tenant_id=$1 AND ... LIMIT $4`,
      [ctx.tenantId, from, to, limit])).rows as never
  },
})
```

Regras de `load`:

- **Sempre** `WHERE tenant_id=$1` com `ctx.tenantId`, além da RLS. Valores só como parâmetros (`$n`). Nada vindo do usuário entra no texto do SQL.
- Devolva as chaves declaradas em `columns`. `money` em **centavos** (inteiro), `date` como `AAAA-MM-DD`, `datetime` em ISO UTC, `number` como número.
- Respeite `limit` (o motor pede `10.001` e recusa acima de 10.000 linhas com 422 `report_too_large`).
- Filtros chegam já validados: `period` vira `{ from, to }` (dia de São Paulo); `choice` é uma chave de `options`; `text` vem aparado, com até 120 caracteres. Para `ILIKE`, escape `%`, `_` e `\`.
- Rótulos para pessoas (situação etc.) podem ser devolvidos já traduzidos. O filtro `choice` usa a chave.

## Rotas

| Rota | Permissão | Uso |
| --- | --- | --- |
| `GET/POST /api/v1/system/custom-reports`, `PUT …/{id}` | `system.reports.read` (+ `manage` para gravar) e as da fonte | Definições salvas. Campos novos: `groupBy`, `totals` |
| `GET /api/v1/reports/sources` | `system.reports.read` | Catálogo das fontes permitidas |
| `POST /api/v1/reports/preview` | `system.reports.read` e as da fonte | Prévia sem salvar (até 500 linhas na resposta) |
| `GET /api/v1/reports/definitions/{id}/run?format=json\|csv\|xlsx\|pdf` | idem | Execução e exportação |
| `GET/POST /api/v1/reports/definitions/{id}/schedules` | leitura; `system.reports.manage` para criar (com `Idempotency-Key`) | Agendas e as últimas 50 execuções |
| `PUT /api/v1/reports/schedules/{id}` | `system.reports.manage`, `If-Match` | Alterar, pausar e reativar |
| `GET /api/v1/reports/runs/{id}/file` | `system.reports.read` e a definição visível | Arquivo enviado na execução |

## Agenda e envio

- O job (`startReportScheduler`, a cada minuto, com `ERP_BACKGROUND_WORKERS_ENABLED=true`) usa `report_due_schedules()` para descobrir ocorrências devidas.
- Cada ocorrência vira uma linha em `report_runs`, com a chave única `(tenant_id, schedule_id, scheduled_for)`. Reinício ou concorrência **nunca reenviam**. Uma ocorrência perdida é executada uma vez, e a agenda volta ao calendário.
- O relatório roda **como o responsável pela agenda**, com as mesmas permissões e a mesma visibilidade da tela. Se ele perder o acesso, a execução é registrada como falha e a agenda é desativada.
- O envio passa pela interface `ReportMailer`. Em produção, ela usa o n8n de `platform/document-mail.ts` (`ERP_DOCUMENT_MAIL_N8N_URL`/`TOKEN`). Os testes usam um stub. Resultados possíveis: `sent`, `failed` ou `unknown` (sem confirmação; não é reenviado).
- Horário de Brasília, UTC−3 fixo (sem horário de verão desde 2019). O dia do mês vai de 1 a 28.

## Fora do motor (por enquanto)

- As análises de estoque (`stock_*`) continuam no executor próprio (`stock-run.ts`). A migração delas para o motor pertence a E9 (#295).
- `products`, `parties` e `stock_movements` são aceitas como definição antiga, sem execução. As fontes reais dessas áreas são dos agentes de cada área.
