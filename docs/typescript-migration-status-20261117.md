# Migração TypeScript • inventário de contratos

Medição local em 17/11/2026 sobre a base `4b4d9f3d90da96ca751266075770fcade30c9652`. Comando reproduzível a partir da raiz:

```powershell
pnpm install --frozen-lockfile --ignore-scripts --filter api-ts...
pnpm --filter api-ts exec tsx ../../verification/ts-migration-inventory.mjs
```

O inventário encontra **389 operações HTTP literais** nos módulos Rust de produção. Dessas, **65 possuem handler registrado no Fastify** e **324 não possuem**. Registro de handler não comprova equivalência funcional, segurança, persistência nem publicação. A medição não cobre dispatch MCP dinâmico nem trabalhadores fora de HTTP.

| Grupo ainda dependente da API nativa | Operações sem handler TypeScript |
| --- | ---: |
| Fiscal | 67 |
| Logística | 15 |
| Sistema | 14 |
| Pedidos • operações complementares | 11 |
| PDV | 11 |
| Garantias | 9 |
| Compras | 9 |
| Produção | 9 |
| Contratos comerciais existentes | 9 |

Os demais grupos aparecem na saída completa, com método, caminho e arquivo/linha original. `GET /api/v1/me` e `GET/POST /api/v1/companies` continuam nativos nesta base. `GET/POST /api/v1/products` e `GET/PUT /api/v1/products/{id}` têm handlers TypeScript registrados.

A fundação adiciona o migrador compatível com o ledger SQLx antes de migrar os domínios restantes. Seguem plataforma/acesso, operação financeira/estoque/compras, produção/logística/PDV/equipe, documentos/SMTP/contratos manuais, fiscal e MCP/OpenAPI. Cada subprojeto precisa preservar seus contratos e controles antes da troca de roteamento. `apps/api` e os jobs Rust só podem ser retirados quando seus consumidores e comportamentos tiverem substituição comprovada.
