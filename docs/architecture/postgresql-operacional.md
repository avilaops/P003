# PostgreSQL operacional • Ávila Ops ERP

## Decisão arquitetural

O Ávila Ops ERP usa PostgreSQL próprio e independente de fornecedor. O backend Rust com SQLx é o único ponto de acesso aos dados transacionais; navegador e aplicações públicas não se conectam diretamente ao banco.

Esta arquitetura preserva migrations SQL, isolamento por empresa, RLS, auditoria e outbox. Serviços de autenticação, arquivos, execução de funções e APIs automáticas de terceiros não fazem parte do banco do ERP.

## Papéis

### Administrador de infraestrutura

Usado somente para provisionar o banco, criar papéis e instalar extensões aprovadas. Não pertence ao runtime nem às rotinas normais de migration.

### Papel de migration

Usado por `DATABASE_MIGRATION_URL`. Pode criar e alterar objetos necessários às migrations versionadas. Não entra no contêiner de aplicação e não é usado para atender requisições.

### `erp_next_app`

Usado por `DATABASE_URL`. Deve ser `NOSUPERUSER`, `NOBYPASSRLS`, não possuir tabelas do ERP, não consultar `_sqlx_migrations` e receber somente os grants exigidos pela API.

### Operador de backup

Pode usar o papel de migration durante uma janela controlada ou um papel dedicado de leitura. O dump nunca utiliza credenciais do runtime por conveniência.

## Variáveis obrigatórias

| Variável | Finalidade | Destino permitido |
|---|---|---|
| `POSTGRES_ALLOWED_HOST` | Hostname DNS exato autorizado | preflight e runtime |
| `DATABASE_URL` | Conexão restrita do `erp_next_app` | processo da API |
| `DATABASE_MIGRATION_URL` | Conexão de migration e backup | automação operacional |
| `DATABASE_MAX_CONNECTIONS` | Limite do pool SQLx | processo da API |

`DATABASE_MIGRATION_URL` nunca deve ser encaminhada ao processo da API, ao Next.js, ao Worker público ou a artefatos de build.

## Contrato da conexão

Produção aceita somente:

• esquema `postgres://` ou `postgresql://`

• hostname exatamente igual a `POSTGRES_ALLOWED_HOST`

• porta 5432

• banco explícito no caminho

• usuário e senha explícitos

• `sslmode=verify-full`

• parâmetros opcionais limitados a `sslmode`, `sslrootcert` e `application_name`

Hostnames semelhantes, subdomínios inesperados, fragmentos, parâmetros duplicados, TLS fraco e usuários administrativos são rejeitados. Desenvolvimento local requer `--allow-local-validation` explícito.

## Migrations

As migrations permanecem em `migrations/` e são aplicadas por SQLx na ordem numérica. A publicação deve usar o SHA exato revisado do repositório; o preflight compara o hash SHA-384 de cada migration no Git com `_sqlx_migrations`.

Fluxo obrigatório:

1. Revisar o código e obter o SHA aprovado.
2. Executar migrations com `DATABASE_MIGRATION_URL`.
3. Executar o preflight contra o mesmo SHA.
4. Confirmar que todas as tabelas essenciais e checksums foram encontrados.
5. Confirmar o papel restrito do runtime.
6. Somente então liberar a versão da aplicação.

Exemplo:

```powershell
$env:POSTGRES_ALLOWED_HOST = 'postgres.internal.example'
$env:DATABASE_MIGRATION_URL = '<conexao-administrativa-com-tls>'
$env:DATABASE_URL = '<conexao-erp-next-app-com-tls>'
python deploy/managed-postgres.py preflight --source-sha <sha-revisado> --require-data
```

## Backup

O backup oficial usa `pg_dump` no formato custom completo, sem filtros de schema, tabela ou dados. O utilitário:

• grava primeiro em arquivo parcial privado

• não sobrescreve destino existente

• verifica o cabeçalho `PGDMP`

• verifica o inventário com `pg_restore --list`

• calcula SHA-256

• publica o arquivo somente após todas as verificações

```powershell
python deploy/managed-postgres.py backup --source-sha <sha-revisado> --require-data --output <novo-arquivo.dump>
```

O arquivo deve ser criptografado, copiado para armazenamento externo e ter retenção definida. A presença de um objeto vazio não constitui backup.

## Restauração

Todo backup precisa ser restaurado periodicamente em um PostgreSQL isolado:

1. Criar banco vazio e papéis temporários.
2. Executar `pg_restore` com owner e privilégios controlados.
3. Rodar o preflight com `--allow-local-validation` quando o teste for local.
4. Comparar migrations, contagens mínimas e tabelas essenciais.
5. Executar smoke tests de pedidos, recebíveis, estoque, fiscal e contratos.
6. Destruir somente o banco temporário depois de registrar a evidência.

Um dump não testado permanece com `restoreTested: false` e não deve ser tratado como recuperação comprovada.

## Rotação de segredo

1. Criar uma nova senha sem revogar imediatamente a conexão ativa.
2. Atualizar o cofre operacional.
3. Atualizar `DATABASE_URL` ou `DATABASE_MIGRATION_URL` no destino correto.
4. Reiniciar somente os consumidores correspondentes.
5. Validar saúde e novas conexões.
6. Revogar a senha anterior.
7. Confirmar que logs e artefatos não contêm o segredo.

As duas credenciais são rotacionadas separadamente.

## Observabilidade

Monitorar:

• conexões por aplicação e papel

• saturação do pool

• duração e bloqueios de queries

• deadlocks

• crescimento de tabelas e índices

• lag de outbox e jobs

• falhas de backup e restauração

• espaço em disco e WAL

`pg_stat_statements` deve permanecer habilitado quando disponível. Queries, corpos, tokens, senhas, CPF, certificados e documentos não podem ser enviados aos logs.

## Recuperação e publicação

Antes de ativar uma versão:

• backup completo verificado

• restauração recente testada

• migrations conferidas contra o SHA revisado

• dados de empresas e identidades presentes

• papel de runtime sem propriedade, superusuário ou bypass de RLS

• TLS validado

• autenticação e serviços fiscais testados

• rollback de aplicação e banco documentado

• workers periódicos analisados separadamente

Falha em qualquer item mantém o runtime em manutenção. Flags de configuração registram pré-condições, mas não substituem a verificação real.
