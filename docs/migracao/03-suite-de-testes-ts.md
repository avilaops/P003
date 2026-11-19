# PR 03 • Suíte de testes e contratos própria do TypeScript

## Objetivo

Hoje o contrato e a verificação usam o Rust como gabarito. Sem Rust, o `api-ts` precisa de testes e de um contrato próprios, completos. Este PR cria a base que os PRs de porte vão estender.

## Escopo
- Gerar o contrato OpenAPI a partir do `api-ts` (zod → OpenAPI) e versioná-lo como fonte de verdade. Substitui o contrato exportado do Rust.
- Reescrever `verification/` (`contracts.mjs`, `discovery.mjs`, `product-context.mjs`) para descobrir rotas e operações no código TypeScript, não em `*.rs`. Ajustar `verification/test/*.test.mjs` e `verification/contracts.json`.
- Padronizar os testes de integração com PostgreSQL do `api-ts`: um helper único de fixture (tenant, identidades, papéis e permissões), em vez de cada arquivo montar o seu.
- Um teste de **cobertura de rotas**: toda rota registrada precisa ter ao menos um teste de sucesso e um de acesso negado.
- Definir como o CI mede o que falta portar, para os PRs 04 a 10 reduzirem esse número.

## Critérios de aceite
- `pnpm test` do repositório roda sem nenhum arquivo Rust.
- Contrato OpenAPI gerado do TypeScript, validado em CI.
- O teste de cobertura de rotas existe e lista as rotas sem teste.
- Documentação curta em `docs/` de como escrever um teste novo de rota.

## Atenção
- Os testes atuais não estão completos. Este PR não precisa cobrir tudo, mas deve deixar o padrão pronto e a lacuna medida.
- Depende do PR 01.

