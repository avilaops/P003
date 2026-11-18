# Estoque • plano de implementação e publicação

**Objetivo** • Entregar em produção as rotinas do levantamento 41 e sua evolução integrada.
**Arquitetura** • API Fastify TypeScript, BFF Next.js, React e PostgreSQL. Preservar escritas históricas e consumidores externos, permissões por empresa e quantidade decimal exata.
**Especificação** • [Levantamento](../../telas/estoque/saldos/LEVANTAMENTO-TELA-41.md) e [roteiro E1 a E9](../../telas/pendencias/estoque.md).

## Regras comuns

Usar TypeScript para aplicação e testes. Usar o migrador TypeScript para migrações de banco. Preservar o isolamento por empresa, idempotência nas operações e rastreabilidade. Não executar builds ou testes Rust. Publicar com referência imutável aos serviços existentes e conferir a revisão pública. Fazer revisão de conformidade e qualidade por etapa.

## Casos de revisão

Tenant trocado em link salvo • SKU com barra e nome duplicado • quantidades fracionárias e custo de entrada desconhecido • repetição e concorrência de movimentos • dados de abertura, reservas e ajustes anteriores à migração.

### Task 1 • Consulta, Kardex e lançamentos TypeScript

- [x] Implementar os contratos GET /stock, GET e POST /stock/movements no Fastify de apps/api-ts com paridade dos campos, permissões, auditoria, idempotência, proteção de reserva/estorno e paginação. No GET de movimentos, fornecer identidade do produto e saldo inicial, final, totais do período, documentos de origem, datas e direções. Gerar os totais fora da página. Verificar limites de data no fuso comercial. Encaminhar pelo BFF TypeScript.
- [x] Nas rotas /estoque, /estoque/saldos, /estoque/lancamentos e /estoque/lancamentos/novo, compartilhar a grade 40/41 com identificação e quantidades distintas, link de linha e foco, pesquisa, paginação e retorno. Implementar página de movimentos por produto, cabeçalho inclusive no histórico vazio, e formulário manual em rota apropriada. Preservar erro, estados vazios, perfil de leitura, teclado e mobile. Implementar acesso direto e descarte de contexto ao trocar tenant. Sem depósito até tarefa 3. Não usar arquivo gerado Rust nem requisitar permissão de catálogo para ler saldo.
- [x] Escrever e executar testes HTTP/PG TypeScript e de navegação Playwright: 10/0/10, 10/3/7, 7/0/7; saldo zero vs falha; SKU de segunda página com barra; leitura apenas, retorno, recarga e mobile. Atualizar testes existentes que dependam do fluxo; confirmar typecheck. Registrar commit e evidência.

### Task 2 • Conferência do estoque

- [x] Migrar o fluxo de contagem existente para API TS, remover o bloqueio de navegação quando verificada a operação real. Reutilizar sessões e vínculos existentes. Implementar conferência cega opcional, reconferência parametrizada e alçada para aprovação, contagem mobile por código. Previna duplo ajuste, concorrência e alteração de estoque entre abertura e aprovação. Preparar escopo real por categoria e depósito em conjunto com tarefa 3.
- [x] Verificar com dados antigos, permissões e aprovações fracionárias em PG via HTTP e navegador. Commit.

### Task 3 • Depósitos, transferências e integração de estoque

- [x] Implementar E1 pelo cadastro de depósitos atual, migração aditiva compatível, principal por tenant, alocação de reservas e abertura reconciliada. Abranger recebimento, pedidos, PDV, produção, NF-e quando movimenta e ajustes. Movimentos antigos permanecem acessíveis. Reutilizar saldos consolidados e garantir que novas movimentações de todos os escritores mantenham posição local coerente; evitar dupla contabilização. Implementar transferências atômicas, estorno conjunto e idempotência, seleção de local e parâmetros por operação. Reconciliar reservas e saldo físico em concorrência.
- [x] Entregar filtro, seleção e coluna depósito, relatório de posição por local, sugestão de padrão na movimentação. Validar em PG: transferência de 2, rejeição por reserva, estorno, isolamento e depósito de abertura. Commit.

### Task 4 • Custo, rastreabilidade, fechamento e reposição

- [x] Implementar E2, E3, E6 e E7. Custo médio ponderado e recálculo do período aberto, vinculação às entradas e valorização de saídas, série única/obrigatória quando habilitada com consulta de origem/destino, integração com saída/devolução/garantia. Fechamento e reabertura auditados e respeitados por escritores. Estoque mínimo, ponto de pedido, lote e prazo por produto, necessidades e compras em aberto para sugestões. UI e contratos TypeScript para parametrizar e operar. Tratar histórico sem custo/série de forma explícita.
- [x] Validar exemplos de cada regra em PostgreSQL e navegador, inclusive recusa após fechamento e duplicidade de série. Commit.

### Task 5 • Produção, relatórios e aceite integrado

- [x] Implementar E8 e E9 com estrutura versionada, consumo e perdas, recebimento do produto acabado com custo e rastreio, evolução de etapas com visibilidade por pedido. Reaproveitar emissão dos relatórios e exportar Kardex, posição valorizada, giro, cobertura, itens parados, divergências, ABC e acurácia a partir dos dados operacionais.
- [x] Cobrir integração de abertura → compra → reserva → baixa → Kardex e relatórios, além do inventário e transferência. Conferir direitos de leitura e ausência de valores inventados. Commit.

### Task 6 • Validação e publicação

- [x] Validar contrato público e BFF TypeScript e estabelecer publicação do estoque com migrações TypeScript e imagem nativa existente, atendendo à restrição de custo. Garantir reprodutibilidade da release e verificações das mudanças. Rodar testes da API com PG, testes de interface, build, arquitetura e revisão final. Resolver conflitos com a main vigente.
- [ ] Publicar o SHA validado via GitHub, acompanhar publicação e verificar saúde, revisão e rotas de estoque na produção por leitura autorizada. Registrar evidência sem escrever dados comerciais de teste em produção.
