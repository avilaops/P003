# D11 • Android e iOS

## Objetivo

Aplicativos nativos que consomem os mesmos contratos, permissões e empresa do ERP web. **Não iniciado.**

## Escopo (roadmap F7 / marco M7 do projeto no Linear)
- App Builder AAD para as telas compatíveis; módulos nativos para câmera, GPS, biometria, notificações e uso offline.
- Android: Kotlin e Jetpack Compose. iOS: Swift e SwiftUI.
- Autenticação OIDC com PKCE e armazenamento seguro (Keystore no Android, Keychain no iOS).
- Contratos, API e empresa compartilhados com o web: o app nunca acessa o banco.
- Distribuição: TestFlight e teste interno do Play. Publicação nas lojas só com aprovação explícita.

## Dependências
- API principal em TypeScript no deploy (PR 02, #283) e o contrato OpenAPI do TypeScript (PR 03, #284).
- Aprovações comerciais e painel de pendências (Meu Negócio, D01) são os primeiros casos de uso naturais no celular.

## Primeira tarefa
Definir quais telas entram na primeira versão (sugestão: aprovações, pendências, consulta de pedidos e cadastro de cliente) e criar o repositório ou pasta dos apps com CI próprio. O ambiente web/backend não exige Android Studio nem Xcode; só esta fase.

## Critério de aceite
Build homologado de cada plataforma consumindo a API TypeScript com login real; sem acesso direto a banco.

