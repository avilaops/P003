# Fiscal: funcionalidades pendentes

[Funcionalidades pendentes](README.md) • [Padrão Protheus](PADRAO-PROTHEUS.md) • [Guias do Fiscal](../fiscal/README.md)

Referência Protheus: Livros Fiscais (SIGAFIS) e o TES (tipo de entrada/saída, MATA080) como ponto central da regra fiscal; documentos eletrônicos via TSS; apuração de ICMS/IPI; SPED Fiscal e Contribuições.

## O que já existe (conferido nos guias)

- **NF-e de saída:** rascunho a partir de pedido/cliente, transmissão por ação separada com checagens de prontidão, cancelamento e carta de correção (endpoints), inutilização de numeração, importação de NF-e emitida fora do ERP.
- **NFC-e:** rascunhos e emissão conforme configuração.
- **Entradas:** Monitor com distribuição da SEFAZ, manifestação, importação de XML; CT-e recebidos com vínculos comerciais; NFS-e recebidas por importação.
- **Configuração:** certificado A1, preferências fiscais, perfis tributários, prontidão (`fiscal/readiness`), eventos fiscais.
- **DANFE** a partir de XML autorizado.
- **Planejado:** NFS-e Nacional de saída (commit `16d97c0c`, "planejar NFS-e Nacional de saída").
- **Indisponível:** guias tributárias.

---

## F1. Tipos de operação (equivalente ao TES)

**Prioridade:** 0–90 dias • **Referência:** TES • Tipo de Entrada e Saída.

**Objetivo.** Concentrar em um cadastro a decisão que hoje fica espalhada entre perfil tributário, pedido e nota: qual CFOP, quais tributos, se movimenta estoque, se gera financeiro.

**Como desenvolver.**
- **Dados:** `operation_types` (código legível, descrição, entrada/saída, CFOP dentro e fora do estado, CST/CSOSN de ICMS, IPI, PIS, COFINS, IBS/CBS, movimenta estoque, gera financeiro, gera comissão, exige nota de origem • devolução —, natureza financeira padrão).
- **Regra de escolha:** padrão por documento (venda de produção própria, revenda, remessa para conserto, devolução, bonificação) e por item; sugestão automática por perfil tributário do cliente e do produto; alteração manual com permissão.
- **Integração:** pedido, NF-e, documento de entrada (Compras C5), devoluções e PDV passam a ler o tipo de operação para estoque, financeiro e tributação. O ERP **não inventa** tributação: tipo sem regra completa bloqueia a transmissão com mensagem clara.
- **Telas:** cadastro em Preferências → Fiscal → Tipos de operação; seletor no item do pedido e da nota.

**Aceite.** Uma remessa para conserto (sem financeiro) sai com o CFOP correto, movimenta estoque e não gera título.

---

## F2. Reforma tributária: IBS e CBS

**Prioridade:** 0–90 dias (2026 é o ano de teste) • **Referência:** atualização legal contínua (documento, seção 3).

**Como desenvolver.** Campos de IBS/CBS (alíquotas de teste de 2026, classificação tributária) nos tipos de operação e nos itens da NF-e conforme o leiaute vigente; cálculo destacado em informativo; simulação da transição para o gestor (já há ferramenta fiscal de simulação disponível na operação). Acompanhar notas técnicas e parametrizar sem novo deploy quando possível.

**Aceite.** NF-e em homologação sai com os grupos de IBS/CBS válidos no schema vigente.

---

## F3. Escrituração de entradas e saídas (livros fiscais)

**Prioridade:** 90–180 dias • **Referência:** livros fiscais de entrada e saída.

**Como desenvolver.** Toda NF autorizada (saída) e todo documento de entrada confirmado (Compras C5) geram registros de escrituração com base, alíquota e valor por tributo; cancelamentos e devoluções ajustam. Consulta de livro de entradas e saídas por período e CFOP. Base para apuração e SPED.

**Aceite.** O livro de saídas do mês lista todas as notas autorizadas, sem as canceladas, com totais por CFOP.

---

## F4. Apuração de impostos e guias

**Prioridade:** 90–180 dias • **Referência:** apuração de ICMS/IPI e guias.

**Como desenvolver.** Apuração mensal de ICMS (débitos − créditos ± ajustes), IPI, PIS/COFINS (conforme regime), DIFAL por UF de destino; geração da guia (DARE/GNRE) com vencimento e título a pagar no Financeiro. Remover `/fiscal/guias` e `/financeiro/tributos` da lista de indisponíveis ao entregar.

**Aceite.** A apuração do mês fecha com a escrituração e gera os títulos das guias.

---

## F5. SPED Fiscal e SPED Contribuições

**Prioridade:** 180–365 dias • **Referência:** geração de arquivos SPED.

Gerar os arquivos a partir da escrituração (F3) e dos cadastros; validação prévia de inconsistências com lista corrigível; histórico de arquivos gerados. Até lá, exportação dos XMLs e livros para o contador.

---

## F6. NFS-e de saída

**Prioridade:** 0–90 dias para quem presta serviço (Serviços/contratos) • **Referência:** documento de serviço.

Seguir o plano já registrado (NFS-e Nacional): emissão a partir de contrato ou ordem de serviço, retenções (ISS, INSS, IR, PIS/COFINS/CSLL), título a receber líquido das retenções, cancelamento.

---

## F7. Contingência e eventos

**Prioridade:** 90–180 dias • **Referência:** contingência SVC/EPEC.

Detectar indisponibilidade da SEFAZ, emitir em contingência conforme regras, retransmitir ao normalizar; painel de documentos pendentes de autorização; eventos (cancelamento, carta de correção, manifestação) com histórico no detalhe da nota.

---

## F8. Devoluções fiscais

**Prioridade:** 90–180 dias. NF de devolução de venda (entrada) e de compra (saída) referenciando a nota de origem, com tributos proporcionais; integra Vendas V5 e Compras C6.

---

## F9. MDF-e (quando houver transporte próprio)

**Prioridade:** 180–365 dias. Manifesto para cargas com veículo próprio, vinculando as NF-e transportadas; encerramento ao final da viagem. Integra Logística L3.

---

## F10. Visão geral com prontidão fiscal

**Prioridade:** 0–90 dias. Conforme o [prompt da visão geral](../fiscal/visao-geral/MELHORIAS.md): certificado, ambiente, numeração, CSC e pendências de autorização no topo.
