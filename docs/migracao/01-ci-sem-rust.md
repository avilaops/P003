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

