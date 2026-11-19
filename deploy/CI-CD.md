# Validação e publicação do ERP

## Fluxos

| Arquivo | Disparo | Resultado |
| --- | --- | --- |
| `ci.yml` | PR ou manual | Lint, testes e banco por escopo; sem publicação |
| `release.yml` | Merge na main, tag `v*` ou manual na main com SHA completo | Validação completa, imagens GHCR, migração, deploy e conferência pública |
| `regression.yml` | Segunda-feira 04:23 UTC ou manual | Regressão completa; sem publicação do ERP |

Os quatro arquivos `_validate-*.yml` são tarefas reutilizáveis. Não possuem
disparos próprios. Infraestrutura desconhecida seleciona todos os módulos no PR.
Os testes de contratos, arquitetura, inventário e banco foram incorporados às
tarefas compartilhadas; o Assistant inativo não tem workflow dedicado.

O portal de contratos conserva a construção manual: selecionar a tarefa
`contracts-portal` em `regression.yml`. A imagem validada fica em
`ghcr.io/avilaops/contracts-portal:sha-<commit>`. Esse fluxo não troca o portal
nem o ERP em produção. Scripts de importação histórica continuam versionados;
bootstrap e reimportação não integram uma publicação normal.

## Preparação inicial

### API TypeScript • dependência permanente

A imagem web da mesma revisão inclui `apps/api-ts`, já compilada e com dependências de execução. O manifesto conserva os quatro componentes existentes. O serviço privado usa essa mesma imagem; não publica portas e compartilha apenas a rede da API Rust em `127.0.0.1:8081`.

No layout de produção `compose.json`, o dispatcher prepara `api-ts` com os parâmetros de banco, autenticação, MCP e motor fiscal. O BFF utiliza a origem privada dessa API. O serviço usa a imagem web validada e a saúde pública verifica as duas APIs.

O envio de documentos pelo n8n usa `ERP_DOCUMENT_MAIL_N8N_URL` e `ERP_DOCUMENT_MAIL_N8N_TOKEN`. Em produção, o dispatcher carrega `/etc/erp-next/document-mail-n8n.env` apenas no serviço `api-ts`. Esse arquivo pertence ao root e usa modo 0600. A credencial do provedor de e-mail fica no n8n. O workflow versionado está em `docs/integrations/n8n-document-mail.json`.

A integração com o Browser Use usa `BROWSER_USE_API_KEY` somente no serviço `api-ts`. No layout Compose, a chave vai em `api-ts.env`. No `compose.json` gerado, o dispatcher a lê do `api-ts` anterior ou do serviço `api` e a conserva entre releases. No runtime Cloudflare, a chave é repassada apenas ao processo TypeScript. A variável é opcional: sem ela, `POST /api/v1/integrations/browser-use/runs` responde 503. Cada execução tem teto de US$ 1. Detalhes em `apps/api-ts/README.md`.

No layout `compose.yaml`, o serviço inicia sem perfil adicional. Antes do primeiro deploy a partir de uma release YAML antiga, prepare obrigatoriamente `api-ts.env` privado a partir de `api-ts.env.example`, com modo 0600 e a mesma role restrita da API. Copie somente as configurações de banco/Auth e a origem MCP; não reutilize o arquivo inteiro da API. O dispatcher conserva esse arquivo nas releases seguintes. O Compose fixa `ERP_TYPESCRIPT_API_URL=http://127.0.0.1:8081` nos serviços API e web. A ausência do arquivo impede a preparação; não deve ser contornada removendo o serviço ou afrouxando a saúde. O layout JSON extrai essa configuração automaticamente e não exige criar o arquivo.

`ERP_TYPESCRIPT_MODULES` foi aposentada e não altera a propriedade dos quatro módulos. O Rust deixou de ser compilado no CI: o código em `apps/api` permanece apenas como referência para portar para o `api-ts`, e o release reaproveita a imagem nativa já publicada. Para recuperar a operação, selecione pelo dispatcher a release anterior completa, com suas imagens e configuração privada, e confirme seu SHA e sua saúde antes de liberar uso. Não há alteração de migrations nesta entrega. Falha ou perda de resposta de comando nunca provoca fallback ou repetição automática; consulte o estado antes de repetir uma intenção. Planeje a soma das conexões dos dois pools. O procedimento detalhado está em [Conclusão dos quatro módulos](../docs/architecture/typescript-api-transition-finalization.md).

O dispatcher precisa ser atualizado no servidor com os bytes revisados de `deploy/production-deploy.sh` antes da publicação, seguindo o procedimento abaixo. A nova release sempre fornece o processo privado; não há etapa de ativação por flags.

Esta mudança não exige trocar os segredos existentes `ERP_DEPLOY_*`. O token
do GitHub Actions precisa poder publicar packages; o Docker do servidor precisa
ter acesso de leitura aos quatro pacotes privados `ghcr.io/avilaops/erp-next-*`.
Não copiar o token de escrita do CI para o servidor nem gravá-lo em arquivos do
repositório. Validar o acesso com a primeira imagem candidata, antes da ativação.

Antes do primeiro deploy deste protocolo, instalar a versão revisada de
`deploy/production-deploy.sh` em `/usr/local/sbin/erp-next-deploy`, conservando
uma cópia privada do dispatcher anterior. Fazer isso sob o lock
`/mnt/HC_Volume_106542212/erp-next/.deploy.lock`, sem release em andamento,
conferindo o SHA-256 dos bytes LF aprovados. A conta SSH continua limitada ao
comando `deploy erp-next <sha>`.

O novo pacote contém somente manifesto, Compose e dois helpers Python. Ele
inclui também os dois scripts revisados de permissões fiscais restritas, aplicados
após as migrações e antes de ativar os serviços. Ele
não é compatível com o dispatcher antigo: este recusará o pacote antes de
alterar os serviços. O código não instala ferramentas nem compila no servidor.

## Publicar

1. Integrar o PR após os checks exigidos pela política do repositório. O merge
   na `main` dispara o Release automaticamente para o commit resultante.
2. Para republicar uma revisão específica, selecionar **Release / Run workflow**,
   branch `main`, e informar o SHA completo integrado; alternativamente, criar
   uma tag de versão `v1.2.3` nesse commit.
3. A seleção confirma que a revisão pertence à main. As imagens são construídas
   e testadas no GitHub e o manifesto aceita apenas os quatro digests do ERP.
4. O ambiente `production` conserva suas proteções. Uma única release executa
   por vez; com vários merges seguidos, fica na fila apenas o mais recente, que
   já contém os anteriores. O servidor baixa os digests usando sua credencial de leitura.
5. O helper aplica somente migrações pendentes da imagem candidata antes de
   ativar os serviços. Preserva o cadastro, os segredos e os volumes existentes.
6. A conferência verifica API, web, página de entrada, mídia e SHA. Falha na
   ativação tenta restaurar o conjunto anterior. Rollback de imagens não desfaz
   automaticamente as migrações do banco.

Todo push na main dispara publicação, para que nenhum código integrado fique
fora de produção. Componentes já publicados com entradas idênticas são
reaproveitados pela seleção.

## Retenção no servidor

- Manter a release ativa e a anterior, identificadas em `deployment-state.json`.
- Remover somente diretórios SHA reconhecidos, imagens com referências exclusivas
  do ERP e temporários `.incoming.*` reconhecidos e abandonados há mais de 24h.
- Proteger todas as imagens referenciadas por containers, inclusive parados e de
  outros projetos, além dos digests necessários para rollback.
- Preservar diretórios desconhecidos, symlinks, volumes e imagens compartilhadas.
- Remover snapshots técnicos antigos de schema/ledger e conservar os das duas
  releases e o diagnóstico da tentativa malsucedida mais recente. Esses snapshots
  não substituem o backup externo dos dados. Outros backups privados não são alvo.
- Limitar logs Docker a três arquivos de 10 MB por serviço.
- Remover o temporário da tentativa atual também em falhas. Uma falha da limpeza
  gera aviso; não restaura uma aplicação saudável por causa de limpeza de disco.

Arquivos de teste expiram em sete dias; manifestos, em 14; evidências técnicas,
em 30. Imagens ficam no GHCR. O servidor não armazena arquivos de imagem `.tar.gz`.

## Tempo de execução

Cada etapa de script executa pelo medidor `scripts/ci/timed.py`, que preserva
o código de saída e registra duração real em segundos, início, job e tentativa.
Os resultados aparecem no resumo do GitHub e nos artefatos `timing-*`, em JSONL,
com expiração de sete dias. Argumentos de comandos, ambiente e segredos não são
gravados no relatório. As Actions de checkout, cache e build mantêm também as
medições nativas do GitHub.

Para simular a limpeza, usar o helper da release aprovada **sem `--apply`**,
informando os SHAs ativo e anterior. Uma execução manual com `--apply` deve
adquirir o mesmo lock de deploy. Não usar limpeza global do Docker.

## Falhas e recuperação

Falhas de pull, manifesto ou migração impedem a troca. Snapshots e diagnósticos
continuam privados. Se o mesmo SHA já tiver uma tentativa de migração, inspecionar
o snapshot existente antes de deliberadamente liberar uma repetição; o helper
nunca sobrescreve esse diagnóstico. Se o rollback falhar, os diretórios e imagens
referenciados pelos containers continuam protegidos e exigem recuperação assistida.

## Validação da mudança

Executar `python -B -m unittest discover -s scripts/ci -p 'test_*.py'`, com
PyYAML 6.0.3 instalado; `python -B -m unittest discover -s scripts/deploy -p
'test_*.py'`; `node --test scripts/mlops/release-gate.test.mjs`; actionlint;
`bash -n deploy/production-deploy.sh`; e os testes fiscais existentes.
