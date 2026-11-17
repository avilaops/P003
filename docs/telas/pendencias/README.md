# Funcionalidades pendentes por tela

[Todas as telas](../../README.md) • [Padrão de desenvolvimento (referência Protheus)](PADRAO-PROTHEUS.md) • [Melhorias de tela](../MELHORIAS-INDICE.md)

Esta pasta reúne **o que ainda falta construir** no ERP e **como construir** com a maturidade de um ERP de referência como o TOTVS Protheus, conforme `docs/strategy/analise-saas-comercial-padrao-totvs.pdf`.

## Como a documentação de telas está organizada

| Pergunta | Onde está |
| --- | --- |
| O que a tela faz hoje e quais são as regras? | `docs/telas/<módulo>/<tela>/README.md` (guia da tela) |
| O que está errado na tela atual e como corrigir a interface? | `docs/telas/<módulo>/<tela>/MELHORIAS.md` + [padrão visual](../PADRAO-MELHORIAS.md) + [índice](../MELHORIAS-INDICE.md) |
| Que funcionalidade ainda não existe e como desenvolvê-la? | **Esta pasta**: um arquivo por módulo + [padrão Protheus](PADRAO-PROTHEUS.md) |
| Quais rotas estão indisponíveis no código? | `apps/web/src/lib/demonstration-routes.ts` (lista) e `apps/web/src/lib/unavailable-features.ts` (texto mostrado ao usuário) |
| Qual é a estratégia e o roteiro? | `docs/strategy/analise-saas-comercial-padrao-totvs.pdf` |

## Arquivos por módulo

| Módulo | Arquivo | Itens |
| --- | --- | --- |
| Vendas | [vendas.md](vendas.md) | V1–V12 |
| Compras | [compras.md](compras.md) | C1–C8 |
| Estoque e produção | [estoque.md](estoque.md) | E1–E9 |
| Financeiro | [financeiro.md](financeiro.md) | FI1–FI13 |
| Fiscal | [fiscal.md](fiscal.md) | F1–F10 |
| Cadastros | [cadastros.md](cadastros.md) | CA1–CA8 |
| Logística e Serviços | [logistica-servicos.md](logistica-servicos.md) | L1–L4, S1–S3 |
| Gestão, relatórios e plataforma | [gestao-plataforma.md](gestao-plataforma.md) | G1–G12 |

## Roteiro consolidado

Ordem alinhada à seção 9 do documento estratégico. Dentro de cada faixa, a ordem sugere dependências (o item de cima destrava os de baixo).

### 0–90 dias: núcleo comercial

| Item | Funcionalidade | Destrava |
| --- | --- | --- |
| [F1](fiscal.md#f1-tipos-de-operação-equivalente-ao-tes) | Tipos de operação (TES) | Devoluções, documento de entrada, remessas |
| [V1](vendas.md#v1-painel-de-aprovações-comerciais) | Painel de aprovações (engine de alçadas) | V2, C3, aprovações no celular |
| [V2](vendas.md#v2-liberação-de-crédito-do-cliente) | Liberação de crédito | Indicador de inadimplência |
| [V3](vendas.md#v3-condição-de-pagamento-cadastrada) / [CA4](cadastros.md#ca4-dados-comerciais-no-cliente) | Condição de pagamento e dados comerciais do cliente | Preenchimento automático do pedido |
| [V4](vendas.md#v4-faturamento-parcial-e-múltiplas-notas-por-pedido) | Faturamento parcial | L1, V10 |
| [FI1](financeiro.md#fi1-baixa-completa-parcial-juros-multa-desconto-e-acréscimos) / [FI2](financeiro.md#fi2-natureza-financeira-e-centro-de-custo-obrigatórios) / [FI8](financeiro.md#fi8-posição-financeira-do-clientefornecedor-ficha-financeira) | Baixa completa, natureza obrigatória, posição do cliente | FI3–FI5, DRE |
| [C3](compras.md#c3-aprovação-de-pedido-de-compra-por-alçada) / [C5](compras.md#c5-documento-de-entrada-completo-nota--pedido--recebimento) | Aprovação de compra e documento de entrada | E2, F3 |
| [E4](estoque.md#e4-kardex-e-posição-do-produto) / [E5](estoque.md#e5-inventário-conferência-de-estoque-ativo) | Kardex e inventário ativo | Acurácia de estoque |
| [F2](fiscal.md#f2-reforma-tributária-ibs-e-cbs) / [F6](fiscal.md#f6-nfs-e-de-saída) / [F10](fiscal.md#f10-visão-geral-com-prontidão-fiscal) | IBS/CBS, NFS-e de saída, prontidão fiscal | Obrigações de 2026 |
| [CA6](cadastros.md#ca6-duplicidade-e-qualidade-cadastral) / [CA8](cadastros.md#ca8-unificação-de-cadastros-pouco-usados) | Qualidade cadastral e unificações | Dados confiáveis para relatórios |
| [G1](gestao-plataforma.md#g1-painel-de-pendências-e-próxima-ação) / [G4](gestao-plataforma.md#g4-dashboards-com-dados-reais) | Painel de pendências, dashboards reais | Visão geral útil |
| [V12](vendas.md#v12-pdv) | Corrigir erro 500 do PDV | • |

### 90–180 dias: escala operacional

E1 saldo por depósito • E2 custo médio • E3 número de série • E6 fechamento de estoque • E7 ponto de pedido • C1 solicitação • C4 sugestões • C6 devolução ao fornecedor • V5 devolução de venda • V6 lista de preço aplicada • V7 metas • V8 margem e ABC • V9 funil completo • V10 garantia com série • V11 importação de pedidos • FI3 fluxo de caixa • FI4 conciliação • FI5 PIX/boleto/CNAB • FI6 adiantamentos • FI9 caixa e data limite • FI11 comissões completas • FI12 DRE gerencial • F3 livros fiscais • F4 apuração e guias • F7 contingência • F8 devoluções fiscais • CA2 transportadoras • CA5 dados de suprimento • CA7 histórico • L1 expedição • L2 envios e frete • L4 reversa • S1 contrato recorrente • S2 ordens de serviço • G2 notificações • G3 motor de relatórios • G5 parâmetros • G6 fechamentos • G7 onboarding • G8 planos • G10 exportação integral • G12 status e suporte.

### 180–365 dias: capacidade empresarial

C2 cotação • C7 avaliação de fornecedores • E8 estrutura e apontamento de produção • FI7 compensação e renegociação • FI10 faturamento agrupado • FI13 contabilidade • F5 SPED • F9 MDF-e • L3 transporte próprio • V11 loja e marketplaces • G9 API pública e webhooks • G11 portais.

## Mapa tela → funcionalidades pendentes

| Tela (rota) | Itens |
| --- | --- |
| Visão geral (`/`) | G1, G4 |
| Dashboards (`/dashboards`) | G4, V7, V8 |
| Eventos, Notificações, Novidades, Aplicativos | G2, G12 |
| Relatórios (`/relatorios`) | G3 |
| Produtos (`/cadastros/produtos`) | CA5, CA6, CA7, E3 |
| Clientes e fornecedores | CA2, CA4, CA6, CA7, V2, FI8 |
| Categorias financeiras, Contas financeiras | FI2, CA3 |
| Formas de pagamento | V3 |
| Grupos de produtos, Grupos de tags, Tags | CA8 |
| Vendas (visão geral) e Funil | V1, V9 |
| Tabela publicada, Simulador | V6 |
| Propostas | V1, V3 |
| Pedidos de venda | V1, V2, V3, V4, V5, F1 |
| PDV | V12, FI9 |
| Garantias | V10, S2 |
| Loja virtual, Anúncios, Importar pedidos | V11 |
| Estoque: saldos e lançamentos | E1, E2, E4, E6 |
| Conferência de estoque | E5 |
| Ordens de produção | E8 |
| Depósitos | E1 |
| Compras: pedidos | C1, C2, C3 |
| Compras: recebimentos e notas de entrada | C5, C6, F3 |
| Sugestões de compra | C4, E7 |
| Financeiro (visão geral) | FI3, FI12 |
| Contas a receber | FI1, FI5, FI6, FI7 |
| Contas a pagar | FI1, FI6 |
| Caixas e bancos | FI4, FI9 |
| Comissões | FI11 |
| Controle de caixa, Ficha financeira, Remessas, Tributos, Contador, Conta digital, Faturamento agrupado | FI9, FI8, FI5, F4, FI13, FI5, FI10 |
| Fiscal (visão geral) | F10 |
| NF-e, NFC-e | F1, F2, F7, F8 |
| Guias tributárias | F4 |
| NFS-e | F6 |
| Logística | L1–L4 |
| Serviços e contratos | S1–S3 |
| Preferências | G5, G7, G8, G10 |

## Divergências encontradas ao montar esta pasta

- **Conferência de estoque:** o guia descreve sessões de contagem funcionando, mas a rota está na lista de indisponíveis do código. Ver [E5](estoque.md#e5-inventário-conferência-de-estoque-ativo).
- **PDV:** o guia descreve o fluxo completo, mas a API de sessões responde 500 para a empresa de exemplo. Ver [V12](vendas.md#v12-pdv).
- **Depósitos:** o cadastro existe, mas os saldos não são divididos por depósito. Prompts antigos que falavam em "saldo por depósito" foram corrigidos; a divisão é o item [E1](estoque.md#e1-saldo-por-depósito-e-transferência-entre-depósitos).
