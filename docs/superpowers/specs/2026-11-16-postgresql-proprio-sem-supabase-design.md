# P003 • PostgreSQL próprio sem Supabase

## Intenção

O ERP Ávila Ops continuará usando PostgreSQL como banco transacional próprio, sem Supabase, Supabase Auth, Data API, Storage, Realtime, Edge Functions ou ferramentas de deploy do Supabase. A remoção deve eliminar dependências de fornecedor sem perder as proteções já construídas para migrations, TLS, backup, restauração, auditoria e isolamento multempresa.

## Objetivos

• Remover configurações, variáveis, testes, scripts e documentação específicos do Supabase.

• Converter a validação de banco gerenciado para PostgreSQL neutro, aceitando um endpoint configurado explicitamente e exigindo TLS verificado.

• Manter o backend Rust com SQLx, as migrations SQL existentes, o papel restrito `erp_next_app`, RLS por `tenant_id`, trilhas de auditoria e o `outbox_events`.

• Documentar a arquitetura futura de documentos, comunicações, relatórios, mídia e medição de uso SaaS.

• Manter o runtime Cloudflare desacoplado do fornecedor do banco.

## Não objetivos

• Não trocar PostgreSQL por outro banco.

• Não remover SQL, migrations, RLS ou schemas somente porque também seriam compatíveis com Supabase.

• Não migrar dados de produção nesta entrega.

• Não alterar regras comerciais, fiscais, financeiras, de estoque ou assinatura.

• Não ativar serviços pagos nem criar infraestrutura externa.

## Restrições

• Segredos não podem aparecer em argumentos de processos, logs, documentação ou artefatos.

• A conexão de runtime deve usar uma conta restrita; migrations usam credencial administrativa separada.

• O hostname do banco deve ser configurado explicitamente e validado contra uma lista permitida, sem aceitar curingas ou inferências por domínio.

• Produção exige TLS com verificação de certificado e hostname.

• Arquivos não relacionados e alterações locais do usuário devem permanecer intactos.

## Abordagens consideradas

### 1 • PostgreSQL neutro preservando automações • escolhida

Excluir todos os conceitos Supabase e generalizar os validadores existentes. Mantém os investimentos em backup, restauração, papéis, testes e runtime Cloudflare. É a opção escolhida porque remove o acoplamento sem reduzir a segurança operacional.

### 2 • Remover todo o runtime gerenciado

Excluir scripts, testes e documentação de banco gerenciado junto com Supabase. A opção foi rejeitada porque descartaria validações úteis e deixaria a futura publicação dependente de procedimentos manuais.

## Alterações previstas

### Remoções

• Excluir `deploy/supabase/README.md`.

• Excluir o plano e a especificação antigos dedicados ao runtime Supabase.

• Remover `SUPABASE_PROJECT_REF`, `SUPABASE_SERVICE_ROLE_KEY`, hostnames `supabase.co` e usuários administrativos do Supabase de código, testes e exemplos.

• Remover referências a Supabase da documentação Cloudflare.

### Generalização PostgreSQL

`deploy/managed-postgres.py` continuará responsável por transformar uma URL validada em variáveis libpq sem expor senha na linha de comando. A validação passará a usar:

• `POSTGRES_ALLOWED_HOST` para o hostname exato autorizado.

• `DATABASE_URL` para a conta restrita de runtime.

• `DATABASE_MIGRATION_URL` para a conta administrativa, usada somente durante migrations e restaurações.

• `sslmode=verify-full` obrigatório em produção.

• rejeição dos usuários `postgres`, `rds_superuser`, `cloudsqlsuperuser` e outros nomes administrativos configurados.

O runtime Cloudflare propagará apenas a URL restrita necessária ao processo do ERP. Credenciais administrativas nunca entram no contêiner de aplicação.

## Arquitetura de dados documentada

### Schemas mantidos

• `public` • dados transacionais do ERP.

• `system_config` • campos personalizados, relatórios, etiquetas e workflows.

• `legacy_evolution` • rastreabilidade de importações e versões legadas.

### Schemas planejados

• `document_engine` • modelos, versões, renderizações e pacotes documentais.

• `communications` • mensagens, anexos, tentativas e preferências de contato.

• `reporting` • execuções, exportações, filtros e consultas analíticas controladas.

• `media` • arquivos, transcrições, segmentos e legendas.

• `internal` • jobs, leases e rotinas que não serão expostas diretamente.

### Extensões PostgreSQL

Manter `pgcrypto` e `pg_stat_statements`. Avaliar por migration própria `pg_trgm`, `unaccent`, `citext`, `btree_gist` e `pg_jsonschema`, somente após confirmar disponibilidade no servidor PostgreSQL escolhido. Nenhuma extensão será habilitada automaticamente nesta limpeza.

### Tabelas planejadas

• `document_engine.document_templates`

• `document_engine.document_template_versions`

• `document_engine.render_jobs`

• `document_engine.rendered_documents`

• `document_engine.document_packets`

• `document_engine.document_packet_items`

• `communications.messages`

• `communications.message_attachments`

• `communications.delivery_attempts`

• `communications.conversation_events`

• `communications.contact_preferences`

• `reporting.report_runs`

• `reporting.report_exports`

• `reporting.saved_filters`

• `reporting.scheduled_reports`

• `media.assets`

• `media.transcription_jobs`

• `media.transcripts`

• `media.transcript_segments`

• `media.subtitle_exports`

• `subscription_plans`

• `plan_features`

• `tenant_entitlements`

• `usage_meters`

• `usage_events`

• `usage_monthly_rollups`

• `feature_overrides`

Essas tabelas são escopo de implementações posteriores. A presente entrega documenta o contrato arquitetural e remove Supabase; não cria estruturas transacionais novas.

## Pacote documental

`document_packet_items.position` será a fonte de verdade da ordem:

1. Pedido
2. Nota fiscal
3. Comprovante de pagamento
4. Contrato
5. Documentos adicionais

O frontend não deverá reconstruir essa ordem. A API devolverá os itens já ordenados.

## Queries oficiais planejadas

• Visão geral de Vendas com contagens completas e registros recentes.

• Busca global por pedido, proposta, cliente, CPF, CNPJ, SKU, contrato e recebível.

• Montagem do pacote documental por `tenant_id`, `packet_id` e `position`.

• Timeline comercial consolidada por cliente.

• Claim concorrente de jobs com `FOR UPDATE SKIP LOCKED`.

• Funil comercial e indicadores financeiros com filtros por empresa e período.

## Segurança

• Toda tabela transacional nova terá `tenant_id`, chave composta quando necessário, RLS ativado e política baseada no contexto definido pela API.

• O frontend não acessará PostgreSQL diretamente.

• Views analíticas ficarão em schema não exposto e serão consultadas pelo backend com permissões mínimas.

• Evidências, versões assinadas, hashes e históricos de entrega permanecem imutáveis.

• Vídeos e PDFs grandes ficam em armazenamento de objetos próprio; PostgreSQL guarda metadados, hashes e referências.

## Verificação

• A busca por `supabase`, ignorando apenas históricos locais não versionados, deve retornar zero ocorrências no conteúdo ativo do projeto.

• Os testes do validador PostgreSQL devem cobrir hostname permitido, TLS obrigatório, usuário restrito, senha fora de argumentos e rejeição de credencial administrativa.

• Os testes do runtime Cloudflare devem confirmar que variáveis administrativas não são encaminhadas ao contêiner.

• A suíte existente de deploy deve permanecer verde.

• O diff final deve conter apenas arquivos relacionados à remoção e à nova documentação.

## Resultado esperado

O repositório deixa de tratar Supabase como opção de infraestrutura. PostgreSQL permanece como componente independente do ERP, com configuração explícita, segurança verificável e documentação suficiente para escolher posteriormente o provedor ou servidor sem alterar o domínio comercial.
