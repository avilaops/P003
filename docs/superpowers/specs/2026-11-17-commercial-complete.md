# Ludus • orçamento, pedido e contrato completos

## Resultado autorizado

Concluir os requisitos do áudio de 17/11: orçamento com informações comerciais e técnicas completas, aprovação que cria pedido preservando o acordo, contrato preparado automaticamente a partir desse pedido, limites comerciais calculados e proteção de custos, comissão, impostos e lucro. O usuário autorizou implementação contínua, integração e publicação. Reutilizar TypeScript para regras novas e PostgreSQL próprio, sem Supabase.

## Estado verificado

Produção em 32f19681; 160 produtos, 157 ativos, fotos vinculadas em 160, 94 fichas e paletas importadas, 38 fichas de bateria preenchidas. Os 66 Core ativos não possuem perfil técnico; usuário confirmou que nacional não tem cor, portanto ausência de paleta é intencional. As tabelas publicadas contêm 91 importados e 64 nacionais; LD-WH065 e LD-WH066 estão fora delas. A planilha original local contém medidas, pesos, baterias e custos nacionais; dois PDFs locais Core corroboram medidas. A pasta Drive fornecida anteriormente contém catálogos importados.

## Decisões de implementação

1. Uma cotação comercial opcional no corpo existente da proposta contém simulação mista e digest. O servidor recalcula com o motor existente, verifica cliente/perfil fiscal, itens, preços e acabamentos e persiste snapshots público e privado por versão. Propostas com produtos de tabela publicada exigem cotação; propostas genéricas de outros tenants conservam comportamento existente.
2. O editor usa tabelas publicadas das duas linhas e a simulação existente. Mostra desconto, UF e contribuinte, total e alçada, mantendo dados financeiros privados apenas para diretoria. PF implica não contribuinte; PJ considera inscrição estadual explícita. Não inventar alíquotas por pessoa física/jurídica: preservar políticas fiscais/comerciais já cadastradas e mostrar o perfil usado.
3. Envio/aceite/conversão revalidam a cotação e impedem vendedor de formalizar preços fora de sua alçada. Diretoria/gerência usam a aprovação existente. A conversão grava o snapshot comercial do pedido na mesma transação, sem obrigar recriação no simulador. Repetições usam a chave de idempotência existente e controle de revisão.
4. Ficha técnica e dados do cliente são congelados na proposta por versão; o documento mostra foto, SKU, acabamentos, dimensões, peso e bateria, diferenciando não aplicável de não informado. Não alterar documentos históricos por mudança de catálogo.
5. Preparar o contrato na transação do pedido com snapshot de cliente, empresa, produtos e condições aprovadas. O fluxo existente de contratos consome a preparação e gera a prévia com o modelo comercial vigente; geração fica idempotente, problemas recuperáveis ficam visíveis. Revisão humana e comando de envio permanecem explícitos. Aprovar orçamento não envia e-mail, solicita assinatura ou realiza cobrança automaticamente.
6. Modelos de teste saem da seleção e de novas gerações comerciais, preservando contratos e arquivos históricos. Preferir restrição explícita por tenant/modelo e escolher o modelo comercial vigente por configuração verificável.
7. Completar dados Core da planilha por SKU/ID confirmado, com proveniência e revisão; não copiar medidas de modelo parecido. Incluir dois itens omitidos com custos/preços da fonte e publicar nova versão compatível. Preservar preços contratados e histórico. Nacional não tem cor: não cadastrar paleta nem solicitar escolha; preservar cores disponíveis apenas nos importados.

## Integridade e aceite

- Mesmas regras em HTTP, MCP e navegador; snapshots privados nunca em respostas de vendedor ou documentos de cliente.
- RLS, permissões, revisão, idempotência e rollback testados em PostgreSQL real; teste de perda de resposta e repetição não cria dois pedidos/contratos.
- Falta de custo/política/dado técnico deve ser explícita e não virar zero inventado. Dados técnicos desconhecidos são pendência de cadastro, não valores estimados.
- Conferir build, lint, testes API e navegador com mouse/teclado e larguras 390/1440, CI e revisão independente final. Fazer publicação com rollback e readback dos dados reais; não criar venda real ou enviar e-mail como teste.
- Somente declarar concluído após evidências de cada requisito. Falta de fonte ou resposta necessária deve permanecer registrada como pendência, com o goal ativo enquanto houver progresso possível.
