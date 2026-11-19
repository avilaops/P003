# PR 01 • CI sem Rust: parar de compilar e testar o Rust

## Objetivo

Remover do CI e dos scripts de pipeline tudo que compila ou executa Rust. O código Rust fica no repositório só como referência para portar. Sobra o typecheck e os testes do TypeScript, o migrador SQL e o PostgreSQL de teste.

## Escopo
- `.github/workflows/_validate-api.yml`: remover toolchain Rust, `cargo fmt`, `cargo clippy`, `cargo test` e exportação do contrato nativo, `cargo build --release`, os passos de cache e verificação do release nativo, "Restore and verify the published native contract" e **"Compare native and TypeScript HTTP contracts"**.
- `.github/workflows/_validate-project.yml`: remover o passo com `dtolnay/rust-toolchain` e `Swatinem/rust-cache` e tudo que depender dele.
- Scripts de pipeline que presumem o Rust, com seus testes: `scripts/ci/pr-gate.py`, `scripts/ci/published-components.py`, `scripts/ci/native-release-cache.mjs`, `scripts/contracts/capture.py`, `scripts/contracts/gate.mjs`, `scripts/ci/test_typescript_api.py`.
- `verification/`: as comparações Rust×TypeScript deixam de existir (o contrato passa a ser o do TypeScript, ver PR 03).

## Fora de escopo
- Imagem e entrada de deploy (PR 02).
- Apagar o código Rust (PR 11).

## Critérios de aceite
- Nenhum passo do CI instala toolchain Rust nem chama `cargo`.
- O job `api` roda typecheck, testes do `api-ts` e migrador contra PostgreSQL, e passa.
- Os testes dos scripts de pipeline (`python -m unittest`, `node --test scripts/**`) passam sem referência ao binário nativo.
- O gate de PR continua exigindo os checks que restam e não reporta check obrigatório ausente.

## Atenção
- O passo `Publish api by immutable digest` constrói a imagem a partir do binário Rust. Neste PR ele pode ser desligado; a nova imagem vem no PR 02.
- Depende da PR #277 estar mesclada (ela alterou os mesmos workflows). Se ainda não estiver, parta da branch dela.


## O que foi feito neste PR
- `_validate-api.yml` reescrito sem nenhum passo de Rust: toolchain, `cargo fmt/clippy/test/build`, cache e verificação do release nativo, "Compare native and TypeScript HTTP contracts" e a publicação da imagem Rust saíram. Ficam: contrato publicado e verificado, typecheck e testes do `api-ts` com PostgreSQL, testes de inventário, migrador SQL e a checagem da imagem publicada.
- `_validate-project.yml`: removidos os jobs `baseline` e `contracts` (captura com `cargo` e comparação `oasdiff`) e o input `typescript_only`; no `contract-tests` saíram o `oasdiff` e os testes do `capture.py`.
- `ci.yml` e `release.yml`: removidos `typescript_only`, `force_native_rebuild`, `native_api` e a variável do Cargo. O release exige sempre a imagem publicada e só reconstrói o fiscal MCP se `apps/fiscal-mcp` mudou (`reuse_mcp`).
- `scripts/ci/published-components.py`: a compatibilidade agora olha só o histórico SQL (somente acréscimo); mudanças em `apps/api` deixam de invalidar o reuso. Nova função `mcp_unchanged` e saída `reuse_mcp`.
- `readOpenApi` foi extraído de `gate.mjs` para `scripts/contracts/openapi-reader.mjs` (usado pelo gerador do cliente web e pelo consumidor).
- Removidos: `gate.mjs` e seus testes, `capture.py` e `test_capture.py`, `package-test-binary.py`, `run-test-binaries.py`, `install-oasdiff.sh`, as baselines e correções revisadas, `native-release-cache.*`, `apps/api-ts/scripts/contract-tests.mjs` e o script `test:contracts`.
- Testes de `scripts/ci` reescritos: nenhum workflow pode conter `cargo`, toolchain Rust ou cache nativo.
- Docs: `docs/tecnica/OPENAPI-CI.md` reescrito; ajustes em `deploy/README.md` e `deploy/CI-CD.md`.

## Verificado localmente
- `python -m unittest discover -s scripts/ci` (62 testes) e `-s scripts/deploy` (48, 8 pulados): ok.
- `node --test scripts/contracts/test/*.test.mjs`, `scripts/ci/*.test.mjs`, `scripts/mlops/*.test.mjs`: ok.
- Todos os workflows carregam como YAML válido.

## Ainda não verificado
- A execução real dos workflows no GitHub (este PR é a primeira execução).
- O código Rust permanece no repositório e o release continua usando a imagem nativa publicada até o PR 02.
