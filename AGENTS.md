# Instruções para agentes

## Publicação do ERP (política fixa)

- Todo merge na `main` publica em produção pelo `Release` (`.github/workflows/release.yml`).
- Não remova nem restrinja o gatilho `push: branches: [main]`, não reintroduza
  publicação só por tag/manual e não acrescente caminhos alternativos que
  pulem o job `deploy`.
- O teste `test_release_deploys_every_main_merge_and_is_serialized`
  (`scripts/ci/test_workflows.py`) protege essa política. Não o altere nem o
  enfraqueça para fazer outra mudança passar.
- Qualquer mudança nessa política exige pedido explícito do responsável pelo
  repositório.
