# D06 • Fiscal: backlog

## Objetivo

Fechar o módulo **Fiscal** (NF-e, NFC-e, monitor, CT-e, NFS-e, DANFE, configurações e certificado). Guias tributárias **nunca foram iniciadas**.

## Telas do menu

| Grupo | Tela | Rota | Estado |
| --- | --- | --- | --- |
| Documentos fiscais | Visão geral | `/fiscal` | Tela existente; completude a auditar |
| Documentos fiscais | NF-e | `/fiscal/notas-saida` | Tela existente; completude a auditar |
| Documentos fiscais | NFC-e | `/fiscal/nfce` | Tela existente; completude a auditar |
| Documentos fiscais | Monitor fiscal e XML recebidos | `/fiscal/monitor` | Tela existente; completude a auditar |
| Documentos fiscais | CT-e recebidos | `/fiscal/ctes` | Tela existente; completude a auditar |
| Documentos fiscais | NFS-e recebidas | `/fiscal/nfses` | Tela existente; completude a auditar |
| Documentos fiscais | DANFE de XML autorizado | `/fiscal/danfe` | Tela existente; completude a auditar |
| Documentos fiscais | Guias tributárias | `/fiscal/guias` | **Indisponível: nunca iniciada**, só pré-visualização (`demonstration-routes.ts`) |
| Configurações | Configurações fiscais | `/preferencias/fiscal` | Tela existente; completude a auditar |
| Configurações | Certificado digital | `/preferencias/certificado-digital` | Tela existente; completude a auditar |

## Backlog (itens da documentação de pendências)

Fonte: `docs/telas/pendencias/` e `docs/telas/<módulo>/`. Itens: F1, F2, F3, F4, F5, F6, F7, F8, F9, F10.

### F1 • Tipos de operação (equivalente ao TES)

_Estado inicial: **a auditar**._

**Prioridade:** 0–90 dias • **Referência:** TES • Tipo de Entrada e Saída.

**Objetivo.** Concentrar em um cadastro a decisão que hoje fica espalhada entre perfil tributário, pedido e nota: qual CFOP, quais tributos, se movimenta estoque, se gera financeiro.

**Como desenvolver.**
- **Dados:** `operation_types` (código legível, descrição, entrada/saída, CFOP dentro e fora do estado, CST/CSOSN de ICMS, IPI, PIS, COFINS, IBS/CBS, movimenta estoque, gera financeiro, gera comissão, exige nota de origem • devolução —, natureza financeira padrão).
- **Regra de escolha:** padrão por documento (venda de produção própria, revenda, remessa para conserto, devolução, bonificação) e por item; sugestão automática por perfil tributário do cliente e do produto; alteração manual com permissão.
- **Integração:** pedido, NF-e, documento de entrada (Compras C5), devoluções e PDV passam a ler o tipo de operação para estoque, financeiro e tributação. O ERP **não inventa** tributação: tipo sem regra completa bloqueia a transmissão com mensagem clara.
- **Telas:** cadastro em Preferências → Fiscal → Tipos de operação; seletor no item do pedido e da nota.

**Aceite.** Uma remessa para conserto (sem financeiro) sai com o CFOP correto, movimenta estoque e não gera título.

---

### F2 • Reforma tributária: IBS e CBS

_Estado inicial: **a auditar**._

**Prioridade:** 0–90 dias (2026 é o ano de teste) • **Referência:** atualização legal contínua (documento, seção 3).

**Como desenvolver.** Campos de IBS/CBS (alíquotas de teste de 2026, classificação tributária) nos tipos de operação e nos itens da NF-e conforme o leiaute vigente; cálculo destacado em informativo; simulação da transição para o gestor (já há ferramenta fiscal de simulação disponível na operação). Acompanhar notas técnicas e parametrizar sem novo deploy quando possível.

**Aceite.** NF-e em homologação sai com os grupos de IBS/CBS válidos no schema vigente.

---

### F3 • Escrituração de entradas e saídas (livros fiscais)

_Estado inicial: **a auditar**._

**Prioridade:** 90–180 dias • **Referência:** livros fiscais de entrada e saída.

**Como desenvolver.** Toda NF autorizada (saída) e todo documento de entrada confirmado (Compras C5) geram registros de escrituração com base, alíquota e valor por tributo; cancelamentos e devoluções ajustam. Consulta de livro de entradas e saídas por período e CFOP. Base para apuração e SPED.

**Aceite.** O livro de saídas do mês lista todas as notas autorizadas, sem as canceladas, com totais por CFOP.

---

### F4 • Apuração de impostos e guias

_Estado inicial: **a auditar**._

**Prioridade:** 90–180 dias • **Referência:** apuração de ICMS/IPI e guias.

**Como desenvolver.** Apuração mensal de ICMS (débitos − créditos ± ajustes), IPI, PIS/COFINS (conforme regime), DIFAL por UF de destino; geração da guia (DARE/GNRE) com vencimento e título a pagar no Financeiro. Remover `/fiscal/guias` e `/financeiro/tributos` da lista de indisponíveis ao entregar.

**Aceite.** A apuração do mês fecha com a escrituração e gera os títulos das guias.

---

### F5 • SPED Fiscal e SPED Contribuições

_Estado inicial: **a auditar**._

**Prioridade:** 180–365 dias • **Referência:** geração de arquivos SPED.

Gerar os arquivos a partir da escrituração (F3) e dos cadastros; validação prévia de inconsistências com lista corrigível; histórico de arquivos gerados. Até lá, exportação dos XMLs e livros para o contador.

---

### F6 • NFS-e de saída

_Estado inicial: **a auditar**._

**Prioridade:** 0–90 dias para quem presta serviço (Serviços/contratos) • **Referência:** documento de serviço.

Seguir o plano já registrado (NFS-e Nacional): emissão a partir de contrato ou ordem de serviço, retenções (ISS, INSS, IR, PIS/COFINS/CSLL), título a receber líquido das retenções, cancelamento.

---

### F7 • Contingência e eventos

_Estado inicial: **a auditar**._

**Prioridade:** 90–180 dias • **Referência:** contingência SVC/EPEC.

Detectar indisponibilidade da SEFAZ, emitir em contingência conforme regras, retransmitir ao normalizar; painel de documentos pendentes de autorização; eventos (cancelamento, carta de correção, manifestação) com histórico no detalhe da nota.

---

### F8 • Devoluções fiscais

_Estado inicial: **a auditar**._

**Prioridade:** 90–180 dias. NF de devolução de venda (entrada) e de compra (saída) referenciando a nota de origem, com tributos proporcionais; integra Vendas V5 e Compras C6.

---

### F9 • MDF-e (quando houver transporte próprio)

_Estado inicial: **a auditar**._

**Prioridade:** 180–365 dias. Manifesto para cargas com veículo próprio, vinculando as NF-e transportadas; encerramento ao final da viagem. Integra Logística L3.

---

### F10 • Visão geral com prontidão fiscal

_Estado inicial: **a auditar**._

**Prioridade:** 0–90 dias. Conforme o [prompt da visão geral](../fiscal/visao-geral/MELHORIAS.md): certificado, ambiente, numeração, CSC e pendências de autorização no topo.

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

