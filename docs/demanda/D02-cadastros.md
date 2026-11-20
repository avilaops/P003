# D02 • Cadastros: backlog e ajustes de navegação

## Objetivo

Fechar o módulo **Cadastros** (empresa, clientes e fornecedores, produtos, categorias, listas de preço, funcionários, contas e categorias financeiras, formas de pagamento, grupos de tags e tags).

## Telas do menu

| Grupo | Tela | Rota | Estado |
| --- | --- | --- | --- |
| (principal) | Visão geral | `/cadastros` | Tela existente; completude a auditar |
| (principal) | Produtos | `/cadastros/produtos` | Tela existente; completude a auditar |
| (principal) | Clientes e fornecedores | `/cadastros/clientes-fornecedores` | Tela existente; completude a auditar |
| (principal) | Funcionários | `/cadastros/funcionarios` | Tela existente; completude a auditar |
| Ferramentas | Contas financeiras | `/cadastros/contas-financeiras` | Tela existente; completude a auditar |
| Ferramentas | Categorias financeiras | `/cadastros/categorias-financeiras` | Tela existente; completude a auditar |
| Ferramentas | Categorias de produtos | `/cadastros/categorias-produtos` | Tela existente; completude a auditar |
| Ferramentas | Listas de preços | `/cadastros/listas-precos` | Tela existente; completude a auditar |
| Ferramentas | Formas de pagamento | `/cadastros/formas-pagamento` | Tela existente; completude a auditar |
| Ferramentas | Grupos de produtos | `/cadastros/grupos-produtos` | Tela existente; completude a auditar |
| Ferramentas | Grupos de tags | `/cadastros/grupos-tags` | Tela existente; completude a auditar |
| Ferramentas | Tags | `/cadastros/tags` | Tela existente; completude a auditar |

## Já feito neste PR
- Breadcrumbs com link nas telas de Clientes e fornecedores e dos cadastros de referência (Contas financeiras, Categorias financeiras, Categorias de produtos, Formas de pagamento, Grupos de tags e Tags), no padrão da tela de Produtos.
- Menu Cadastros na ordem pedida: Meu negócio, Clientes e fornecedores, Produtos, Categorias de produtos, Listas de preços, Funcionários, Contas financeiras, Categorias financeiras, Formas de pagamento, Grupos de tags e Tags (Grupos de produtos ao final).
- Typecheck e testes de `apps/web` ainda **não foram rodados** para estes dois ajustes: rodar antes de tirar o PR de rascunho.

## Backlog (itens da documentação de pendências)

Fonte: `docs/telas/pendencias/` e `docs/telas/<módulo>/`. Itens: CA1, CA2, CA3, CA4, CA5, CA6, CA7, CA8.

### CA1 • Condições de pagamento

_Estado inicial: **a auditar**._

Ver [Vendas V3](vendas.md#v3-condição-de-pagamento-cadastrada). Cadastro novo em Cadastros → Condições de pagamento.

### CA2 • Transportadoras

_Estado inicial: **a auditar**._

**Prioridade:** 90–180 dias • **Referência:** cadastro de transportadoras.

**Como desenvolver.** Reaproveitar o cadastro único de pessoas com o relacionamento "Transportadora" (como Cliente/Fornecedor hoje), com dados de RNTRC e modalidade. Selecionável no pedido (frete pago pelo cliente com transportadora indicada), na NF-e (grupo de transporte) e na Logística. Vínculo com CT-e recebidos.

**Aceite.** A transportadora escolhida no pedido aparece preenchida na NF-e.

### CA3 • Centros de custo

_Estado inicial: **a auditar**._

Ver [Financeiro FI2](financeiro.md#fi2-natureza-financeira-e-centro-de-custo-obrigatórios). Cadastro hierárquico simples (código, nome, responsável, situação).

### CA4 • Dados comerciais no cliente

_Estado inicial: **a auditar**._

**Prioridade:** 0–90 dias • **Referência:** campos de venda do cadastro de clientes.

**Como desenvolver.** Aba "Comercial" no cliente: vendedor responsável (carteira), condição de pagamento padrão, lista de preço, transportadora padrão, limite de crédito e risco (Vendas V2), tipo de operação padrão (Fiscal F1), região. Esses valores preenchem o pedido automaticamente (gatilhos) e continuam editáveis.

**Aceite.** Escolher o cliente no Novo pedido preenche condição, vendedor e transportadora, com a origem indicada.

### CA5 • Dados de suprimento no produto

_Estado inicial: **a auditar**._

**Prioridade:** 90–180 dias. Aba "Suprimentos" no produto: estoque mínimo, ponto de pedido, lote de compra, prazo do fornecedor, fornecedor preferido (Estoque E7), controla número de série (Estoque E3), unidade de compra e fator de conversão, NCM/CEST validados contra a tabela oficial.

### CA6 • Duplicidade e qualidade cadastral

_Estado inicial: **a auditar**._

**Prioridade:** 0–90 dias • **Referência:** documento, seção 3 ("requer deduplicação, qualidade cadastral e histórico mais uniforme").

**Como desenvolver.** Detecção de prováveis duplicados (nome normalizado parecido, mesmo e-mail ou telefone, produtos com nomes quase iguais como "Agachamento Pêndulo" e "Agachamento Pendulum"); tela de mesclagem com escolha do registro principal, mantendo os documentos vinculados; indicador de completude (sem foto, sem NCM, cliente sem IE ou endereço).

**Aceite.** A tela de duplicados lista os pares suspeitos e a mesclagem preserva os documentos dos dois registros.

### CA7 • Histórico de alterações em todo cadastro

_Estado inicial: **a auditar**._

**Prioridade:** 90–180 dias. Aba "Histórico" com quem alterou, quando e o quê (antes/depois), a partir do `audit_log` já existente.

### CA8 • Unificação de cadastros pouco usados

_Estado inicial: **a auditar**._

**Prioridade:** 0–90 dias. Unificar Grupos de tags dentro de Tags; decidir Grupo × Categoria de produtos (ver prompts de [grupos](../cadastros/grupos-produtos/MELHORIAS.md) e [tags](../cadastros/tags/MELHORIAS.md)).

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

