# PR 02 • API em TypeScript como API principal no deploy

## Objetivo

Hoje o binário Rust é a porta de entrada e o `api-ts` roda atrás dele (gateway). Passar o `api-ts` a ser a API principal: nova imagem, ponto de entrada, supervisor de runtime e release.

## Escopo
- Criar `deploy/api-ts.Dockerfile` (Node, `apps/api-ts` compilado, healthcheck em `/health/ready`) e o ponto de entrada de produção (`apps/api-ts/src/server.ts` já existe).
- `deploy/cloudflare/runtime-supervisor.mjs` e `deploy/cloudflare/runtime.Dockerfile`: lançar o `api-ts` em vez de `/usr/local/bin/erp-next-api`.
- `deploy/compose.yaml`, `deploy/migrate-release.py`, `deploy/README.md` e `deploy/CI-CD.md`: trocar a imagem `erp-next-api` pela do TypeScript.
- Remover o gateway: `apps/api/src/platform/typescript_gateway.rs` deixa de existir como caminho de produção (o código só sai de vez no PR 11).
- `.github/workflows/release.yml`: construir e publicar a imagem do `api-ts` por digest.

## Fora de escopo
- Portar rotas (PRs 04 a 10).

## Critérios de aceite
- `docker build` da nova imagem funciona e o contêiner sobe, responde `/health/ready` e conecta ao PostgreSQL.
- O release publica a imagem do TypeScript por digest e o deploy a usa.
- As 142 rotas ainda não portadas respondem **404** claro (aceito, o sistema não está em produção) e estão listadas nos PRs 04 a 10.
- Testes dos scripts de deploy atualizados e verdes (`scripts/deploy/test_*.py`).

## Atenção
- Depende do PR 01 (CI sem Rust) para o release não tentar compilar Rust.

