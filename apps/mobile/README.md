# Apps móveis • ERP

Android (Kotlin e Jetpack Compose) e iOS (Swift e SwiftUI). Os apps falam **só com a API do ERP**
(`apps/api-ts`), com o mesmo Auth, as mesmas permissões e a mesma empresa do ERP web. Não acessam banco.

## Telas da v1

| Tela | Rotas |
| --- | --- |
| Login (OIDC + PKCE, cliente público `erp-mobile`) | Auth: `/.well-known/openid-configuration`, authorize, token |
| Seleção de empresa | `GET /api/v1/companies`, `POST /api/v1/company-selection`, `GET /api/v1/me` |
| Pendências (provisório: pedidos em rascunho) | `GET /api/v1/orders?status=draft` |
| Pedidos e detalhe | `GET /api/v1/orders`, `GET /api/v1/orders/{id}` |
| Aprovação de preço | `GET /api/v1/orders/{id}/pricing`, `POST /api/v1/orders/{id}/pricing/approve` |
| Cadastro rápido de cliente | `POST /api/v1/parties` |

## Contrato

`contract/operations.json` lista as operações usadas. `node apps/mobile/contract/generate.mjs` gera
`ErpOperations` em Kotlin e Swift a partir de `apps/api-ts/openapi.json`; `--check` roda no CI.
Rotas ainda ausentes do contrato TypeScript ficam em `pending`, com a dependência declarada.
Os modelos de resposta são mínimos e escritos no app até o contrato publicar schemas (#284).

## Segurança

- Login no navegador do sistema (Custom Tabs / `ASWebAuthenticationSession`); a senha não passa pelo app.
- Tokens: Android Keystore (AES-GCM) e Keychain (`ThisDeviceOnly`). Biometria opcional desbloqueia a sessão.
- Nenhum segredo no repositório: o cliente OIDC é público. Endereços de homologação entram por
  `-Perp.apiBaseUrl` (Android) e `ERP_API_BASE_URL` (iOS); no CI vêm da variável `ERP_MOBILE_API_BASE_URL`.
- Chaves de assinatura (keystore do Play, certificados Apple) ficam fora do repositório.

## Build local

```bash
# Android (exige SDK; `-Perp.coreOnly=true` testa só o núcleo JVM, sem SDK)
cd apps/mobile/android && ./gradlew :core:test :app:assembleDebug -Perp.apiBaseUrl=https://<api-homologacao>
# iOS (exige Xcode e `brew install xcodegen`)
cd apps/mobile/ios && xcodegen generate && xcodebuild test -project ErpMobile.xcodeproj -scheme ErpMobile \
  -destination 'platform=iOS Simulator,name=iPhone 16'
```

## Distribuição

O CI de PR gera apenas APK de debug e app de simulador. Teste interno do Play e TestFlight exigem
contas, assinatura e aprovação explícita do responsável; **não há publicação nas lojas automática**.
