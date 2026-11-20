# PR 07 • Porte para TypeScript: logística

## Objetivo

Portar checkout, despacho e as demais rotas de logística.

## Escopo

### Rotas a portar (15)

| Método | Caminho | Handler Rust |
| --- | --- | --- |
| GET | `/api/v1/logistics/checkouts` | `apps/api/src/domains/logistics_checkout.rs:51` |
| POST | `/api/v1/logistics/checkouts` | `apps/api/src/domains/logistics_checkout.rs:51` |
| GET | `/api/v1/logistics/checkouts/{id}` | `apps/api/src/domains/logistics_checkout.rs:52` |
| POST | `/api/v1/logistics/checkouts/{id}/complete` | `apps/api/src/domains/logistics_checkout.rs:65` |
| GET | `/api/v1/logistics/checkouts/{id}/labels` | `apps/api/src/domains/logistics_dispatch.rs:29` |
| POST | `/api/v1/logistics/checkouts/{id}/labels` | `apps/api/src/domains/logistics_dispatch.rs:29` |
| POST | `/api/v1/logistics/checkouts/{id}/lines/{line}/check` | `apps/api/src/domains/logistics_checkout.rs:53` |
| POST | `/api/v1/logistics/checkouts/{id}/packages` | `apps/api/src/domains/logistics_checkout.rs:57` |
| POST | `/api/v1/logistics/checkouts/{id}/packages/{package_id}/status` | `apps/api/src/domains/logistics_checkout.rs:61` |
| GET | `/api/v1/logistics/labels` | `apps/api/src/domains/logistics_dispatch.rs:28` |
| GET | `/api/v1/logistics/postings` | `apps/api/src/domains/logistics.rs:77` |
| POST | `/api/v1/logistics/postings` | `apps/api/src/domains/logistics.rs:77` |
| GET | `/api/v1/logistics/postings/{id}` | `apps/api/src/domains/logistics.rs:78` |
| POST | `/api/v1/logistics/postings/{id}/packages` | `apps/api/src/domains/logistics_dispatch.rs:33` |
| POST | `/api/v1/logistics/postings/{id}/status` | `apps/api/src/domains/logistics.rs:79` |

### Arquivos Rust de origem

- `apps/api/src/domains/logistics.rs`
- `apps/api/src/domains/logistics_checkout.rs`
- `apps/api/src/domains/logistics_dispatch.rs`

## Como fazer (todo PR de porte)
1. Para cada rota da lista, ler o handler Rust indicado e reproduzir **método, caminho, permissões exigidas, validações, cabeçalhos (`If-Match`, `Idempotency-Key`), códigos de status e formato do corpo**.
2. Implementar em `apps/api-ts/src/modules/<domínio>/`, no padrão dos módulos existentes (zod para entrada, `authorizeRequest` e `requirePermission`, isolamento por empresa), e registrar em `apps/api-ts/src/app.ts`.
3. Escrever **testes novos** em `apps/api-ts/test/` (PostgreSQL de teste, no estilo de `postgres-sales.test.ts`). Cobrir sucesso, 401/403, validação 422, conflito 409/412 e idempotência quando existir. Os testes atuais não estão completos e não devem ser a única referência.
4. Não apagar nada em `apps/api` (Rust). A remoção é do último PR.
5. Rodar `pnpm --filter api-ts typecheck` e `pnpm --filter api-ts test` antes de pedir revisão.

## Critérios de aceite
- Todas as rotas da lista respondem pelo `api-ts` com o mesmo contrato do Rust, ou com divergência **documentada** na descrição do PR.
- Testes novos cobrindo cada rota (caminho feliz, sem permissão, entrada inválida e conflito).
- Typecheck e testes do `api-ts` verdes no CI.
- Rotas registradas em `apps/api-ts/src/modules/*-endpoints.json` ou equivalente, se o inventário do repositório exigir.

## Observações
- O sistema ainda não está em produção: não é preciso manter compatibilidade nem rodar em paralelo com o Rust.
- Conflitos esperados com os outros PRs de porte: só a linha de registro em `app.ts`. Resolver mantendo as duas linhas.
- Contagem e origem das rotas vêm de `verification/ts-migration-inventory.mjs` (status `native_only`).


## Resultado do porte

Módulo `apps/api-ts/src/modules/logistics/` (`postings.ts`, `checkouts.ts`, `dispatch.ts`), registrado em `app.ts`. Testes em `apps/api-ts/test/logistics.test.ts` (sucesso, 401, 403, só leitura, 422, 404, 409, 412, 428, idempotência, concorrência com o mesmo `If-Match` e isolamento por empresa). Inventário: as 15 operações saíram de `native_only` (97 → 82).

### Divergências em relação ao Rust

| Rota | Rust | TypeScript | Motivo |
| --- | --- | --- | --- |
| `GET /logistics/checkouts/{id}/labels` | Ignorava o `{id}` e listava a fila inteira da empresa | Filtra pela conferência; 404 se ela não existe | Bug: a tela de uma conferência mostrava etiquetas de outras |
| `POST /logistics/postings/{id}/packages` | `ON CONFLICT DO NOTHING` respondia como vinculado um volume que já pertencia a outra postagem | 409 se algum volume já está em outra postagem; 409 para postagem cancelada ou entregue | O retorno mentia sobre o vínculo |
| `POST /logistics/postings/{id}/packages` | Só exigia `logistics.checkout.*` | Exige também `logistics.postings.read` e `logistics.postings.manage` | A operação altera a postagem |
| Comandos com `If-Match` (status da postagem, conferência de linha, volumes, status do volume, conclusão) | O registro de idempotência não guardava o `{id}`/linha/volume: a mesma chave em outro recurso devolvia o resultado do primeiro | O pedido gravado inclui os identificadores da rota; outra rota com a mesma chave dá 409 | Repetição devolvia resultado de outro registro |
| `POST /logistics/postings` | Resposta com parte dos campos; transportadora e rastreio sem limite | Resposta com a postagem completa (superconjunto); transportadora ≤ 80 e rastreio ≤ 60 caracteres, vazio vira `null` | Entrada sempre validada |
| `POST /logistics/checkouts/{id}/packages` | `labelCode` sem limite; volume nº 1000 caía no CHECK do banco | `labelCode` ≤ 60; 409 "Limite de volumes" | Mensagem clara |
| `POST /logistics/postings/{id}/status` | Aceitava campos extras | Corpo estrito (campo desconhecido → 422) | Padrão zod do projeto |
| `POST .../complete` e `POST .../labels` | `complete` exigia um JSON qualquer | Corpo ausente ou `{}`; outro conteúdo → 422 | Sem corpo com significado |
| Parâmetro de caminho inválido (UUID ou nº de linha) | 400 do extrator do axum | 404, como os demais módulos TS | Padrão do `api-ts` |

### Etiquetas

O Rust não gera arquivo nem PDF: `POST .../labels` só enfileira trabalhos (`logistics_label_jobs`) e as listas respondem `application/json`. O porte mantém isso; os testes conferem o `Content-Type` e que a fila de outra empresa ou conferência não aparece. A impressão e o PDF são do backlog L1–L4 (#299).
