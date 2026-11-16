# Pedido misto • cabeçalho e seleção unificada

Pedido do usuário: cabeçalho de Novo pedido conforme referência, com título destacado, descrição, situação real, Copiar proposta e Salvar PDF; retirar escolha exclusiva de tabela e permitir equipamentos nacionais e importados juntos. Preservar as correções NF-e já implementadas nesta branch.

## Decisões

• Busca consulta ambas as tabelas publicadas e preserva origem/versão em cada item. Falta de publicação em uma linha não oculta a outra. Produto com duas origens não recebe preço arbitrário; manter identidade e escolha explícitas, sem duplicar o mesmo produto no pedido.
• Precificação mista é autoridade do servidor, com regras por versão, IPI por item, desconto racional global, frete único rateado com conservação exata de centavos, entradas mínimas somadas e união dos motivos/alçadas de aprovação. Cálculo legado permanece intacto.
• Taxa fixa comum é aplicada uma vez. Taxas divergentes nas políticas usadas causam conflito explícito; não escolher maior, menor ou duplicar sem política definida. Consulta read-only da Ludus em16/11 confirmou ambas as configurações em zero; isso não substitui validar os snapshots publicados.
• APIs legadas mantêm seus schemas e funcionamento. Novas rotas POST `/api/v1/commercial/mixed/simulate` e `/api/v1/commercial/mixed/orders` atendem o novo cliente. Não tornar nullable campos escalares de respostas antigas.
• `MixedSimulationInput`: destinationState, taxpayer, discount, freightCents, downPaymentCents e items; cada item contém line/versionId obrigatórios mais os mesmos campos de acabamento/quantidade do legado. Criar pedido recebe `{simulation,digest,customerId,dueDate,checkout?,opportunityId?,opportunityRevision?}` como no legado, com tipo misto.
• `MixedSimulation`: tenantId, digest, sale e director; sale mantém agregados monetários e itens usados no cliente, inclui policyGroups, provenance por item. IPI/entrada/taxa agregados não uniformes são null em campos exclusivos desse novo schema, com detalhamento por grupo. FreeDiscountBps agregado pode usar menor limite como indicação conservadora; aprovação usa todos os grupos reais.
• Digest inclui todas as políticas, versões, fontes e revisão de aprovação. Conversão refaz cálculo no lock do tenant e confere digest. Versões relacionadas em tabela própria imutável/RLS; nenhuma versão individual é gravada como representante fictícia do pedido misto.
• Checkout, replay/incerteza, fiscal, contratos, documentos e aprovações precisam ler pedidos legados e mistos. Custos e lucro permanecem restritos à gestão autorizada. Snapshot fiscal lê valores por item sem inventar IPI global.
• Cabeçalho: Liberado somente com cálculo atual sem aprovação necessária; antes disso, situação de preenchimento/cálculo/aprovação. Ações copiar/PDF usam exclusivamente proposta comercial atual, nunca custos/margens nem tela operacional. Não criar registros ou transmitir documentos nessas ações. PDF usa padrão comercial, emitente conferido e indicação de proposta não salva.

## Validação

Testar pedido com duas linhas, percent/amount/total, taxas/IPI/entrada diferentes, frete único, centavos, taxa fixa incompatível, perda em uma linha, alterações de política/produto/versão/digest, isolamento e replay. Testar legado/POS/fiscal/checkout. Na UI, busca conjunta, manutenção de itens/cliente, cabeçalho e ações funcionais, estados reais e mobile.
