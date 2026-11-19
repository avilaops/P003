# PR 11 • Remover o backend Rust

## Objetivo

Quando as rotas só no Rust chegarem a zero, apagar o `apps/api` inteiro, o gateway e tudo que existe só para o Rust.

## Escopo
- Apagar `apps/api/`, `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, `.cargo/`, `.sqlx/`, `deploy/api.Dockerfile` e o que sobrar de `erp-next-api`.
- Remover referências em `.github/`, `scripts/`, `deploy/`, `README.md`, `docs/` e `architecture/`.
- Remover o inventário Rust→TypeScript e os arquivos de migração que perderem sentido (`verification/ts-migration-inventory.mjs`, `docs/migracao/`).

## Critérios de aceite
- `git grep -i "cargo\|rustc\|erp-next-api"` não encontra nada fora do histórico.
- CI verde sem nenhum passo de Rust.
- Antes de apagar: o inventário de rotas só no Rust mostra **0**.

## Atenção
- **Só abrir para merge depois dos PRs 04 a 10.** Este PR existe agora apenas para registrar o escopo.

