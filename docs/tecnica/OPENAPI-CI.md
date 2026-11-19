# Contrato OpenAPI no CI

O Rust não é mais compilado no CI. O contrato HTTP usado pelos consumidores é o **contrato publicado**,
versionado em `scripts/contracts/published/` (`candidate.json.gz`, `company.json.gz` e `manifest.json`
com os resumos SHA-256 e os digests das imagens publicadas).

## O que o CI faz com ele
- `scripts/ci/published-components.py restore` descompacta os dois arquivos em `artifacts/contracts/`,
  confere os resumos e recusa a restauração se o histórico SQL (`migrations/`) deixar de ser apenas
  acréscimo em relação ao commit publicado.
- O job `api` valida o contrato com o consumidor (`scripts/contracts/consumer`) e com
  `scripts/fiscal/check-contract.mjs`, e o publica como artefato `erp-openapi-<sha>-<tentativa>`.
- O job `web` baixa esse artefato e gera os tipos do cliente com `scripts/contracts/generate-web.mjs`
  (a leitura e validação do OpenAPI está em `scripts/contracts/openapi-reader.mjs`).
- O fiscal MCP é reaproveitado da imagem publicada enquanto `apps/fiscal-mcp` não mudar.

## O que foi removido
Compilação, lint e testes do Rust, exportação do contrato por `cargo test`, captura de baseline,
comparação com `oasdiff`, o gate de compatibilidade e a comparação HTTP Rust × TypeScript.

## Próximo passo
O contrato passa a ser gerado a partir do `api-ts` (PR 03, suíte de testes e contratos própria do
TypeScript). Até lá, o arquivo publicado é congelado: mudanças nas rotas do TypeScript não alteram
o contrato que o `web` consome.
