# Dados do SaaS comercial • Ávila Ops ERP

## Princípios

• PostgreSQL é a fonte de verdade transacional.

• Toda informação de negócio pertence a uma empresa identificada por `tenant_id`.

• A API aplica autorização e define o contexto de empresa antes de consultar dados.

• RLS oferece defesa adicional e não substitui permissões da aplicação.

• Históricos, versões assinadas, hashes e evidências são imutáveis.

• Campos estruturados usam colunas relacionais; `jsonb` fica restrito a snapshots e payloads variáveis.

## Extensões

Mantidas:

• `pgcrypto` • UUIDs, hashes e evidências

• `pg_stat_statements` • diagnóstico de queries

Candidatas, condicionadas à disponibilidade do servidor e a uma migration revisada:

• `pg_trgm` • busca aproximada

• `unaccent` • normalização de pesquisa em português

• `citext` • comparação de e-mails sem diferença de caixa

• `btree_gist` • restrições de períodos sobrepostos

• `pg_jsonschema` • validação de layouts e configurações JSON

Nenhuma extensão candidata é pré-requisito desta documentação.

## Schemas

### Atuais

• `public` • transações do ERP

• `system_config` • campos personalizados, relatórios, etiquetas e workflows

• `legacy_evolution` • rastreabilidade do legado

### Planejados

• `document_engine` • modelos, versões, renderizações e pacotes

• `communications` • mensagens, anexos, entregas e conversas

• `reporting` • execuções, exportações, filtros e agendamentos

• `media` • arquivos, transcrições, segmentos e legendas

• `internal` • jobs, leases e rotinas privadas

## Estruturas existentes que não serão duplicadas

O modelo atual já cobre:

• pedidos e itens em `sales_orders` e `sales_order_lines`

• propostas versionadas em `sales_proposals`, `sales_proposal_versions` e `sales_proposal_lines`

• contratos e arquivos em `commercial_contracts` e `commercial_contract_files`

• assinatura individual, participantes, documentos, revisões e evidências

• títulos e pagamentos em `receivables` e `receivable_payments`

• comprovantes em `order_supporting_documents`

• histórico de e-mail comercial e financeiro

• configurações SMTP em `platform_mail_settings`

• auditoria e eventos em `audit_log` e `outbox_events`

• relatórios declarativos em `system_config.report_definitions`

## Motor de documentos

### Tabelas

`document_engine.document_templates` • identidade, tipo e estado do modelo por empresa.

`document_engine.document_template_versions` • conteúdo versionado, engine, hash e data de publicação.

`document_engine.render_jobs` • fila idempotente de geração.

`document_engine.rendered_documents` • snapshot, revisão de origem, arquivo, hash e resultado imutável.

`document_engine.document_packets` • pacote relacionado a pedido ou contrato.

`document_engine.document_packet_items` • documento, seção e posição.

Campos comuns: `tenant_id`, UUID, revisão, status, timestamps e autor. Binários grandes ficam em armazenamento de objetos próprio; o banco guarda `storage_key`, mídia, tamanho e SHA-256.

### Ordem oficial do pacote

1. Pedido
2. Nota fiscal
3. Comprovante de pagamento
4. Contrato
5. Documentos adicionais

`document_packet_items.position` é a fonte de verdade. A API devolve o pacote ordenado e o frontend não recompõe a sequência.

## Comunicações

### Tabelas

• `communications.messages`

• `communications.message_attachments`

• `communications.delivery_attempts`

• `communications.conversation_events`

• `communications.contact_preferences`

Cada mensagem guarda contexto, destinatário, assunto, conteúdo, chave idempotente, snapshot e estado. Tentativas registram provedor, resposta normalizada, timestamps e erro seguro. Tabelas atuais de e-mail permanecem como evidência até uma migração específica.

## Relatórios

### Tabelas

• `reporting.report_runs`

• `reporting.report_exports`

• `reporting.saved_filters`

• `reporting.scheduled_reports`

`system_config.report_definitions` continua declarativa. Usuários escolhem dataset, colunas, filtros e visibilidade; nunca fornecem SQL. A API mantém listas permitidas de datasets, colunas, operadores e permissões.

Datasets planejados: pedidos, propostas, contratos, recebíveis, pagamentos, comissões, estoque, compras e documentos fiscais.

## Mídia e transcrição

### Tabelas

`media.assets` • referência do vídeo ou áudio, mídia, duração, tamanho e hash.

`media.transcription_jobs` • modelo, idioma, estado, tentativas, disponibilidade e lease.

`media.transcripts` • texto completo, idioma, modelo e confiança.

`media.transcript_segments` • sequência, início, fim, locutor, texto e confiança.

`media.subtitle_exports` • SRT, VTT ou TXT, referência e hash.

Vídeos e áudios não ficam em `bytea`. Jobs usam claim transacional e leases; uma falha não pode criar duas transcrições finais para o mesmo asset e versão de modelo.

## Recursos SaaS e medição

### Tabelas

• `subscription_plans`

• `plan_features`

• `tenant_entitlements`

• `usage_meters`

• `usage_events`

• `usage_monthly_rollups`

• `feature_overrides`

Eventos de uso são append-only e idempotentes. Rollups mensais aceleram faturamento sem substituir os eventos. Entitlements controlam usuários, armazenamento, documentos, minutos transcritos, mensagens e módulos.

## Índices essenciais

Toda lista operacional inicia por `tenant_id`. Padrões principais:

```sql
create index sales_orders_tenant_updated_idx
    on sales_orders(tenant_id, updated_at desc, id desc);

create index document_packet_items_order_idx
    on document_engine.document_packet_items(tenant_id, packet_id, position);

create index transcription_jobs_claim_idx
    on media.transcription_jobs(tenant_id, available_at, lease_until, id)
    where status in ('pending', 'leased');
```

Índices trigram só serão criados após medir a pesquisa real e confirmar a função imutável de normalização.

## Queries oficiais

### Visão geral de Vendas

Retorna contagens completas por status, valores agregados e até cinco pedidos e propostas ordenados por `updated_at desc, id desc`. Contagens não dependem do limite da lista.

### Busca global

Pesquisa código do pedido, proposta, cliente, CPF, CNPJ, SKU, contrato e recebível. A consulta normaliza entrada, limita resultados por entidade e sempre filtra `tenant_id` antes da ordenação.

### Pacote documental

```sql
select i.position, i.section, d.document_type, d.storage_key, d.content_sha256
from document_engine.document_packet_items i
join document_engine.rendered_documents d
  on d.tenant_id = i.tenant_id and d.id = i.document_id
where i.tenant_id = $1 and i.packet_id = $2
order by i.position;
```

### Timeline comercial

Consolida proposta, pedido, contrato, assinatura, nota, recebível, pagamento, mensagem e anexo por cliente. A implementação deve usar view privada ou query da API, preservando autorização e paginação.

### Claim concorrente

```sql
select id
from media.transcription_jobs
where tenant_id = $1 and status = 'pending' and available_at <= now()
order by available_at, id
for update skip locked
limit 1;
```

O claim e a mudança para `leased` ocorrem na mesma transação.

## Segurança e qualidade

Cada tabela nova deve ter chave primária, `tenant_id`, foreign keys compostas quando necessário, checks de estado, RLS forçada e política de empresa. UPDATE exige predicados de leitura e escrita equivalentes. Funções privilegiadas ficam fora de schemas expostos, têm `search_path` fixo e grants explícitos.

Antes de publicar uma migration:

• testar isolamento entre duas empresas

• testar idempotência e concorrência

• revisar índices com `EXPLAIN (ANALYZE, BUFFERS)` em dados representativos

• verificar funções, views, triggers e grants

• executar backup e restauração de homologação

• gerar os tipos e contratos da API correspondentes
