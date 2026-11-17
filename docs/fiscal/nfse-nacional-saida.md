# NFS-e Nacional de saída • MEI

## Escopo

O ERP emite NFS-e Nacional v1.01 para o MEI de Ribeirão Preto • código IBGE `3543402`. A API TypeScript mantém tenant, idempotência, persistência e auditoria. O `fiscal-engine` TypeScript prepara e assina a DPS, valida os XMLs e usa mTLS com o certificado A1.

Produção permanece bloqueada. A ativação inicial aceita somente `homologation` e o endpoint oficial de Produção Restrita.

## Configuração privada

O processo `api-ts` exige as variáveis abaixo para habilitar homologação:

```dotenv
NFSE_ISSUANCE_ENABLED=true
ERP_FISCAL_ENGINE_URL=http://127.0.0.1:8091
ERP_FISCAL_ENGINE_TOKEN=SEGREDO_PRIVADO_COM_PELO_MENOS_24_CARACTERES
FISCAL_A1_KEYRING={"active":"...","keys":{"...":"..."}}
```

`ERP_FISCAL_ENGINE_URL` aceita somente origem HTTP de loopback. O token, o keyring, o PFX, a senha e os XMLs nunca podem ser enviados ao navegador ou gravados em logs.

Aplicar a migration `202611170001_outgoing_nfse.sql` e depois [grant-outgoing-nfse.sql](../../deploy/grant-outgoing-nfse.sql) com a conta administrativa. A role de serviço do `app.avilaops.com` precisa das permissões `fiscal.outgoing_nfse.read`, `fiscal.outgoing_nfse.issue` e `fiscal.outgoing_nfse.cancel` somente no tenant autorizado.

## API privada

Todas as rotas exigem Bearer OAuth válido e `X-Tenant-Id`. Escritas também exigem `Idempotency-Key` UUID.

• `POST /api/v1/integrations/nfse/issuances` • cria e transmite uma DPS em homologação

• `GET /api/v1/integrations/nfse/issuances/{id}` • consulta o estado persistido

• `GET /api/v1/integrations/nfse/issuances/{id}/xml` • entrega o XML somente após autorização

• `POST /api/v1/integrations/nfse/issuances/{id}/reconcile` • consulta a SEFIN quando o estado é `processing` ou `uncertain`

• `POST /api/v1/integrations/nfse/issuances/{id}/cancel` • registra o cancelamento de uma nota autorizada

A mesma chave e o mesmo corpo reproduzem a resposta persistida. A mesma chave com outro corpo responde `409`. Timeout ou indisponibilidade produz `uncertain`; a emissão não é retransmitida e deve seguir por `reconcile`.

## Homologação

1. Confirmar empresa com CNPJ MEI, certificado A1 do mesmo CNPJ e cadastro do tomador.
2. Manter `NFSE_ISSUANCE_ENABLED=false` durante migration, grants e verificação de saúde.
3. Ativar a flag e emitir uma fixture de Produção Restrita autorizada pelo responsável fiscal.
4. Guardar como evidência o ID interno, a chave de acesso, os horários e o resultado da consulta. Não copiar PFX, senha ou XML para tickets e logs.
5. Exercitar replay, consulta de estado incerto, isolamento entre tenants e cancelamento.

## Rollback

Definir `NFSE_ISSUANCE_ENABLED=false` e recriar somente `api-ts`. Isso desabilita novos comandos sem apagar notas, eventos ou XMLs. Manter o banco e consultar manualmente qualquer registro `processing` ou `uncertain`; remover tabelas ou repetir transmissão não é rollback, é fabricação artesanal de problema fiscal.

Reativar apenas depois de reconciliar estados incertos e validar a release anterior completa.
