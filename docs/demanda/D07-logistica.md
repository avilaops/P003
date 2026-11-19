# D07 • Logística: backlog

## Objetivo

Fechar o módulo **Logística**. Envios, etiquetas e logística reversa **nunca foram iniciados**.

## Telas do menu

| Grupo | Tela | Rota | Estado |
| --- | --- | --- | --- |
| Operação | Visão geral | `/logistica` | Tela existente; completude a auditar |
| Operação | Objetos de postagem | `/logistica/postagens` | Tela existente; completude a auditar |
| Operação | Logística reversa | `/logistica/reversa` | Tela existente; completude a auditar |
| Operação | Checkout de pedidos | `/logistica/checkout` | Tela existente; completude a auditar |
| Operação | Etiquetas | `/logistica/etiquetas` | Tela existente; completude a auditar |
| Operação | Ávila Envios | `/logistica/envios` | **Indisponível: nunca iniciada**, só pré-visualização (`demonstration-routes.ts`) |

## Backlog (itens da documentação de pendências)

Fonte: `docs/telas/pendencias/` e `docs/telas/<módulo>/`. Itens: L1, L2, L3, L4.

### L1 • Expedição e romaneio

_Estado inicial: **a auditar**._

**Prioridade:** 90–180 dias • **Referência:** montagem de carga e expedição.

**Como desenvolver.** A partir de pedidos faturados: separação (itens e séries • Estoque E3), conferência, volumes e peso (o peso bruto já é calculado no pedido), romaneio por veículo/transportadora, impressão. Estados: A separar → Separado → Conferido → Expedido → Entregue. Entrega confirmada atualiza o pedido (Vendas V4) e dispara o início da garantia.

**Aceite.** Um pedido expedido mostra romaneio, volumes, transportadora e data de entrega no detalhe.

### L2 • Envios, etiquetas e cotação de frete

_Estado inicial: **a auditar**._

**Prioridade:** 90–180 dias. Integração com transportadoras/intermediadores (Ávila Envios): cotar frete pelo peso e destino, contratar, gerar etiqueta, rastrear com eventos no pedido. Remover `/logistica/envios*` e `/logistica/etiquetas/*` da lista de indisponíveis ao entregar.

### L3 • Transporte próprio e MDF-e

_Estado inicial: **a auditar**._

**Prioridade:** 180–365 dias. Cadastro de veículos e motoristas, viagens com as NF-e transportadas, emissão e encerramento do MDF-e (Fiscal F9).

### L4 • Logística reversa

_Estado inicial: **a auditar**._

**Prioridade:** 90–180 dias. Coleta de devolução ou assistência: autorização, agendamento de coleta, recebimento e destino (estoque, assistência), integrado a Vendas V5 e V10.

---

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

