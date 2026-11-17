# Cadastros: funcionalidades pendentes

[Funcionalidades pendentes](README.md) • [Padrão Protheus](PADRAO-PROTHEUS.md) • [Guias de Cadastros](../cadastros/README.md)

Referência Protheus: cadastros básicos • produtos (MATA010), clientes (MATA030), fornecedores (MATA020), transportadoras (MATA050), condições de pagamento, vendedores, naturezas e centros de custo • com consulta padrão, validações e dados complementares por módulo.

## O que já existe (conferido nos guias)

Produtos (com ficha técnica, custos, acabamentos e paleta), clientes e fornecedores em cadastro único (consulta de CNPJ/CEP, endereços e contatos, dados fiscais declarados), funcionários (com vendedor), categorias de produtos e financeiras com hierarquia, contas financeiras, formas de pagamento, listas de preços, grupos de produtos, grupos de tags e tags, depósitos. Arquivar/reativar sem apagar histórico em todos.

---

## CA1. Condições de pagamento

Ver [Vendas V3](vendas.md#v3-condição-de-pagamento-cadastrada). Cadastro novo em Cadastros → Condições de pagamento.

## CA2. Transportadoras

**Prioridade:** 90–180 dias • **Referência:** cadastro de transportadoras.

**Como desenvolver.** Reaproveitar o cadastro único de pessoas com o relacionamento "Transportadora" (como Cliente/Fornecedor hoje), com dados de RNTRC e modalidade. Selecionável no pedido (frete pago pelo cliente com transportadora indicada), na NF-e (grupo de transporte) e na Logística. Vínculo com CT-e recebidos.

**Aceite.** A transportadora escolhida no pedido aparece preenchida na NF-e.

## CA3. Centros de custo

Ver [Financeiro FI2](financeiro.md#fi2-natureza-financeira-e-centro-de-custo-obrigatórios). Cadastro hierárquico simples (código, nome, responsável, situação).

## CA4. Dados comerciais no cliente

**Prioridade:** 0–90 dias • **Referência:** campos de venda do cadastro de clientes.

**Como desenvolver.** Aba "Comercial" no cliente: vendedor responsável (carteira), condição de pagamento padrão, lista de preço, transportadora padrão, limite de crédito e risco (Vendas V2), tipo de operação padrão (Fiscal F1), região. Esses valores preenchem o pedido automaticamente (gatilhos) e continuam editáveis.

**Aceite.** Escolher o cliente no Novo pedido preenche condição, vendedor e transportadora, com a origem indicada.

## CA5. Dados de suprimento no produto

**Prioridade:** 90–180 dias. Aba "Suprimentos" no produto: estoque mínimo, ponto de pedido, lote de compra, prazo do fornecedor, fornecedor preferido (Estoque E7), controla número de série (Estoque E3), unidade de compra e fator de conversão, NCM/CEST validados contra a tabela oficial.

## CA6. Duplicidade e qualidade cadastral

**Prioridade:** 0–90 dias • **Referência:** documento, seção 3 ("requer deduplicação, qualidade cadastral e histórico mais uniforme").

**Como desenvolver.** Detecção de prováveis duplicados (nome normalizado parecido, mesmo e-mail ou telefone, produtos com nomes quase iguais como "Agachamento Pêndulo" e "Agachamento Pendulum"); tela de mesclagem com escolha do registro principal, mantendo os documentos vinculados; indicador de completude (sem foto, sem NCM, cliente sem IE ou endereço).

**Aceite.** A tela de duplicados lista os pares suspeitos e a mesclagem preserva os documentos dos dois registros.

## CA7. Histórico de alterações em todo cadastro

**Prioridade:** 90–180 dias. Aba "Histórico" com quem alterou, quando e o quê (antes/depois), a partir do `audit_log` já existente.

## CA8. Unificação de cadastros pouco usados

**Prioridade:** 0–90 dias. Unificar Grupos de tags dentro de Tags; decidir Grupo × Categoria de produtos (ver prompts de [grupos](../cadastros/grupos-produtos/MELHORIAS.md) e [tags](../cadastros/tags/MELHORIAS.md)).
