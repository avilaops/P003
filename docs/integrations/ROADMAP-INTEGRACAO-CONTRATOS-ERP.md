# ROADMAP

## INTEGRAÇÃO CONTRATOS X ERP

> Objetivo: quem usa o ERP faz **tudo o que o portal de contratos faz sem sair do ERP**. O portal
> (`contrato.avilaops.com`) vira o **motor de assinatura** e fica visível só para quem assina.
>
> Este plano foi montado lendo o código dos dois lados (ERP: repositório `P003`; portal: este
> repositório). O que não foi confirmado está marcado como **a validar**. O código do ERP vive em
> `P003`; este documento diz o que construir lá e o que o portal precisa oferecer.

### 1. Princípios

| Princípio | O que significa |
| --- | --- |
| ERP é a interface e o registro | Telas, permissões, estados e histórico ficam no ERP. O portal não é fonte da verdade do negócio. |
| Portal é o motor | Preenchimento, convites, assinatura, evidências e trilha. Sempre chamado pelo **servidor** do ERP, nunca pelo navegador. |
| Quem assina de fora usa o portal | Signatário externo recebe o link e assina no portal. Isso não muda. |
| Sem segredo no navegador | Tokens ficam no servidor do ERP; o navegador só fala com o BFF do ERP. |
| Cada passo é verificável | Fase só termina com teste de contrato e prova no ambiente real. |

### 2. Estado verificado hoje

#### 2.1 ERP (`P003`)

O ERP **já tem um módulo de contratos grande**. Não se parte do zero.

| Peça | Onde | O que faz |
| --- | --- | --- |
| Contratos comerciais | `apps/web` `/servicos/contratos`, `/vendas/pedidos/[id]/contratos` | Gerar prévia, revisar o PDF, enviar, atualizar andamento, baixar PDF assinado e trilha |
| Modelos | `/servicos/contratos/modelos`, `template-canvas`, `template-workspace` | Editor próprio; **publica versões** no portal |
| API de contratos | `apps/api-ts/src/modules/commercial-contracts` | `GET/POST /api/v1/commercial-contracts`, `:id/review`, `:id/send`, `:id/sync`, `:id/files/:file` |
| Webhook do portal | `company-account/contract-webhook.ts` | `POST /api/v1/webhooks/contracts/:tenant`, só `submission.*` e `form.*`, com segredo e deduplicação por resumo |
| Reconciliação | mesmo arquivo | Consulta `submitters`, `submissions/:id` e `documents` no portal e preserva PDF e trilha |
| Pacote por SMTP | `commercial-contracts/email.ts` | Contrato + pedido + NF-e + comprovante, pelo SMTP do ERP |
| ICP-Brasil individual | `contract-signatures`, `contract-signature-validator/service` | **Desenho e núcleo do validador; o próprio documento diz que não está implantado nem homologado** |

Ações que existem na tela hoje: gerar prévia, revisar, enviar, atualizar andamento, baixar PDF,
trilha de assinatura, enviar pacote, assinaturas ICP.

#### 2.2 Portal (este repositório)

Sobre o DocuSeal: tema e marca, SMS adaptativo, logo da empresa, lembretes automáticos, envio em massa,
SSO por OpenID Connect, API de publicação do ERP, CPF e CNPJ, selfie ao vivo com consentimento,
relatório de auditoria e log encadeado por hash.

Estado do portal em produção: uma instalação, **banco do app antigo**, uma conta ativa que concentra
os templates de todas as empresas. O ERP guarda `tenant → ids de template` em
`DOCUSEAL_TENANT_TEMPLATES`. O portal já foi preparado para **várias contas na mesma instalação,
cada uma com o próprio certificado** (PR #7).

### 3. Arquitetura alvo

```mermaid
flowchart LR
    U[Usuário do ERP] --> W[ERP web<br/>telas de contratos]
    W --> B[BFF do ERP]
    B --> A[API do ERP<br/>commercial-contracts]
    A --> DB[(Banco do ERP<br/>estado, histórico, PDFs)]
    A -- "token do tenant<br/>HTTPS, servidor a servidor" --> P[Portal de contratos<br/>API + Admin API]
    P -- "webhooks assinados<br/>submission.* / form.*" --> A
    P --> S[Signatário externo<br/>link no e-mail / SMS]
    A --> V[Validador ICP<br/>ERP]
    P -. "embed (fase 5)<br/>assinante interno" .-> W
```

#### 3.1 Enviar contrato e acompanhar

```mermaid
sequenceDiagram
    actor Usuário
    participant ERP as ERP (tela e API)
    participant Portal
    actor Signatário
    Usuário->>ERP: Gerar prévia e revisar
    Usuário->>ERP: Enviar (canal: e-mail / SMS)
    ERP->>ERP: Congela snapshot, hash e destinatários
    ERP->>Portal: POST /api/submissions (um convite por participante)
    Portal-->>ERP: id do envio
    Portal->>Signatário: Convite com link (lembretes automáticos)
    Signatário->>Portal: Preenche, tira selfie, assina
    Portal->>ERP: webhook form.* / submission.completed
    ERP->>Portal: GET submissions/:id e documents (reconciliação)
    ERP->>ERP: Preserva PDF, trilha e evidências
    ERP-->>Usuário: Estado atualizado e documentos
```

### 4. Matriz de paridade: portal → ERP

Legenda: ✅ já existe no ERP · 🟡 parcial · ❌ falta · **API** = o portal ainda precisa de endpoint.

| # | Função do portal | No ERP hoje | Lacuna | Como fechar | Fase |
| --- | --- | --- | --- | --- | --- |
| 1 | Modelos com editor e publicação | ✅ editor próprio, publica versões | Tipos **selfie** e **CPF/CNPJ** não existem no editor nem na API | Portal aceita `image` com `capture: camera` e `validation: cpf\|cnpj` (**entregue neste PR**); editor do ERP ganha os dois tipos | F1 |
| 2 | Gerar contrato, revisar, enviar por participante | ✅ | — | — | — |
| 3 | Acompanhar andamento e baixar PDF e trilha | ✅ | A trilha nova (selfie, CPF, hash) já chega pelo `audit_log_url` | Conferir que o ERP preserva o relatório novo | F4 |
| 4 | Pacote por SMTP (contrato, pedido, NF-e) | ✅ só do ERP | — | — | — |
| 5 | Reenviar convite | ❌ | Botão e estado | `PUT /api/submitters/:id` (a validar a semântica de reenvio) | F2 |
| 6 | Cancelar ou arquivar envio | ❌ | Botão, estado `cancelled`, tratar `submission.archived` | `DELETE /api/submissions/:id` | F2 |
| 7 | Corrigir e-mail ou telefone do participante | ❌ | Tela e regra de revisão do snapshot | `PUT /api/submitters/:id` | F2 |
| 8 | Prorrogar prazo | ❌ | Tela | **A validar:** campo de prazo na API de envio; se faltar, **API** | F2 |
| 9 | Linha do tempo de eventos do envio | 🟡 só a trilha em PDF | Tela com eventos | `submission_events` já vem em `GET /api/submissions/:id` | F2 |
| 10 | Lembretes automáticos (configurar) | ❌ | Tela de configuração | **API** `/api/avila/settings` (lembretes) | F3 |
| 11 | SMS (canal e provedor) | ❌ | Escolher canal no envio; configurar provedor | `send_sms` + telefone no envio; **API** de configuração | F3 |
| 12 | Logo e nome da empresa nas telas de assinatura | ❌ | Marca por empresa | **API** `/api/avila/branding`; depende da decisão de contas (seção 6) | F3 |
| 13 | Evidência da selfie e CPF/CNPJ | ❌ | Mostrar na ficha do contrato | **API** `/api/avila/submissions/:id/evidence` | F4 |
| 14 | Verificar integridade do log (hash) | ❌ | Botão "verificar" | **API** de verificação (a confirmar se o relatório já basta) | F4 |
| 15 | Envio em massa (CSV/XLSX) | ❌ | Lote de contratos | **Nativo do ERP** (fila + um contrato por linha, idempotente), reaproveitando o fluxo atual | F5 |
| 16 | Assinar sem sair do ERP (signatário interno) | ❌ | Tela com o formulário embutido | `embed_src` do participante + `frame-ancestors` do portal | F5 |
| 17 | Usuários e SSO do portal | ❌ | **Não é necessário** para o usuário final | O ERP chama o portal por servidor; SSO só para suporte técnico | — |
| 18 | ICP-Brasil individual | 🟡 desenho e validador | Não implantado nem homologado | Seguir o desenho do próprio ERP; **fora do escopo desta lista** até haver certificado real de teste | F6 |

### 5. Contrato entre ERP e portal

#### 5.1 Já existe e funciona (verificado em produção em 20/11/2026)

- Autenticação por `X-Auth-Token` (token por conta).
- `GET /api/user`, `GET /api/templates`, `GET /api/submissions` (200, com os 3 templates e 4 envios).
- `GET` e `POST /api/avila/templates/:id`: publicação idempotente, versão imutável.
- `DELETE /api/templates/:id` (arquivar), webhooks com segredo.

#### 5.2 O que o portal precisa ganhar (Admin API, a construir neste repositório)

| Endpoint (proposta) | Para quê | Fase |
| --- | --- | --- |
| `POST /api/avila/accounts` (token de plataforma) | Provisionar a conta de um tenant, com certificado próprio, e devolver o token **uma única vez** | F0 |
| `GET/PUT /api/avila/settings` | Lembretes (1º, 2º, 3º), prazo padrão, provedor de SMS, textos de e-mail | F3 |
| `PUT /api/avila/branding` | Logo e nome da empresa | F3 |
| `GET /api/avila/submissions/:id/evidence` | Selfie (hash, IP, aparelho, consentimento), validação de CPF/CNPJ, estado da cadeia de hash | F4 |
| Cabeçalho de embed (`frame-ancestors`) | Permitir o ERP incorporar o formulário do signatário interno | F5 |

Todos exigem o token da conta, devolvem erro padronizado e **nunca** devolvem segredo.

#### 5.3 O que o ERP usa da API padrão (a validar uma a uma antes da fase 2)

Reenvio (`PUT /api/submitters/:id`), arquivar (`DELETE /api/submissions/:id`) e correção de participante.
Cada uma entra com teste de contrato contra o portal real de homologação.

### 6. Decisão central: contas e marca por empresa

Hoje **todas as empresas compartilham uma conta do portal**. Isso impede marca, certificado, SMS e
lembretes por empresa, e foi justamente o risco que o PR #7 tratou.

| Opção | Prós | Contras |
| --- | --- | --- |
| **A. Uma conta do portal por empresa (recomendada)** | Certificado, logo, SMS e lembretes próprios; isolamento real; alinhado ao PR #7 | Migrar os modelos da conta única; guardar um token por empresa |
| B. Conta única e marca por envio | Nada a migrar | Certificado e marca únicos; empresas se misturam |

Recomendação: **A**. O token de cada empresa fica no cofre ou no banco do ERP (cifrado), e
`DOCUSEAL_TENANT_TEMPLATES` deixa de existir. **Atenção:** o ERP lê `DOCUSEAL_URL` e exige o host
`contrato.avilaops.com`; manter esse host.

### 7. Segurança e conformidade

- Tokens só no servidor do ERP, por empresa, rotacionáveis. Nunca no navegador nem em log.
- Webhook assinado e deduplicado (já existe); estender a lista de eventos tratados.
- Idempotência e `If-Match` nas ações novas, como no resto do ERP.
- **LGPD:** selfie, IP e localização são dado pessoal; o consentimento já é obrigatório no portal e
  **o texto precisa de revisão jurídica**. Definir retenção e quem pode ver a evidência no ERP.
- O servidor só prova o que observa (IP, hora, aparelho, hash); **não prova que a imagem veio de uma câmera**.
- Embed (F5): liberar só a origem do ERP, só nas telas de assinatura, nunca no painel do portal.

### 8. Fases

```mermaid
flowchart LR
    F0[F0<br/>Decisões e<br/>fundações] --> F1[F1<br/>Modelos<br/>completos]
    F1 --> F2[F2<br/>Ciclo do<br/>contrato]
    F2 --> F3[F3<br/>Canais, lembretes<br/>e marca]
    F3 --> F4[F4<br/>Evidências e<br/>auditoria]
    F4 --> F5[F5<br/>Lote e<br/>assinar no ERP]
    F5 --> F6[F6<br/>ICP-Brasil<br/>homologado]
```

| Fase | Entrega | Critério de aceite |
| --- | --- | --- |
| **F0** | Decidir contas por empresa; `POST /api/avila/accounts`; token por empresa no ERP | Duas empresas de teste, cada uma com certificado e token próprios; uma não enxerga o modelo da outra |
| **F1** | Editor do ERP com selfie e CPF/CNPJ; portal aceita (**portal entregue neste PR**) | Modelo publicado com os dois tipos; o formulário do portal exibe a câmera e recusa CPF inválido |
| **F2** | Reenviar, cancelar, trocar participante, prorrogar, linha do tempo; novos estados e eventos | Cada ação testada contra o portal de homologação; estado do ERP reconcilia com o do portal |
| **F3** | Tela de configuração de lembretes, SMS e marca; canal no envio | Lembrete chega no prazo configurado; SMS sai pelo provedor; a logo da empresa certa aparece |
| **F4** | Evidência e integridade na ficha do contrato; relatório preservado | Selfie, CPF e hash visíveis no ERP; relatório novo preservado junto ao PDF |
| **F5** | Envio em lote nativo; assinatura embutida do signatário interno | Lote de N contratos idempotente; signatário interno assina dentro do ERP |
| **F6** | ICP-Brasil individual homologado | Só com certificado real de teste, PDF real e o validador aprovando |

Cada fase termina com: teste de contrato (catálogo `verification/contracts.json` do ERP), CI verde nos
dois repositórios e uma prova no ambiente real, não só em teste isolado.

### 9. Riscos e decisões em aberto

| Item | Risco ou pergunta | Tratamento |
| --- | --- | --- |
| Contas por empresa | Migrar modelos da conta única sem quebrar envios pendentes | Migrar por empresa, com backup e janela; manter o mapeamento antigo até acabar |
| Servidor | Pouca memória e swap alto; lembretes e lote usam o Sidekiq do portal | Medir após o primeiro uso real; limitar tamanho do lote |
| Webhook | Ordem e repetição de eventos | Deduplicação por resumo (existe) e reconciliação por consulta |
| ICP-Brasil | Hoje o portal assina com cadeia própria autoassinada; não é ICP | Tratar na F6 com certificado real |
| Selfie | Não testada em navegador real; texto de consentimento sem revisão jurídica | Teste manual em HTTPS antes de uso real |
| Quem implementa no ERP | O código do ERP está em `P003` | Definir quem abre as mudanças lá |

### 10. Divisão de trabalho

| Repositório | Itens |
| --- | --- |
| Portal (`contratos.avilaops.com`) | F0 provisionamento; F1 **(entregue)**; Admin API de configurações, marca e evidência; cabeçalho de embed |
| ERP (`P003`) | Editor com os novos tipos; ações novas no `contracts.tsx`, no BFF (`contracts-proxy.ts`) e em `commercial-contracts/routes.ts`; tratamento de novos eventos em `contract-webhook.ts`; telas de configuração, evidências e lote; token por empresa |

### 11. O que já foi entregue deste plano

- **F1, lado do portal:** a API de publicação do ERP agora aceita campos `image` com
  `capture: "camera"` (selfie ao vivo, com consentimento e evidência) e campos `text` com
  `validation: "cpf" | "cnpj"` (o servidor confere os dígitos verificadores). Qualquer outra combinação é recusada.
  Testes em `spec/requests/api_avila_templates_spec.rb`.
- **ICP-Brasil, passo 1 (prioridade definida em 20/11/2026):** a tela de certificados do portal
  (Configurações > Assinatura eletrônica) agora reconhece e rotula o certificado instalado: ICP-Brasil ou não,
  titular (e-CNPJ ou e-CPF) e nível (A1 a A4). Código em `lib/icp_brasil.rb`. **Isto só classifica pelo emissor e
  pelas políticas declaradas; não valida a cadeia contra a raiz da ICP-Brasil nem a revogação**, e a tela diz isso.

### 12. ICP-Brasil: ordem de execução

| Passo | O que | Depende de | Estado |
| --- | --- | --- | --- |
| 1 | Reconhecer e rotular o certificado (e-CNPJ/e-CPF, A1 a A4) | — | Entregue (PR #16) |
| 2 | Validar a cadeia contra as raízes oficiais da ICP-Brasil, a validade e o uso da chave; bloquear como padrão um certificado vencido | Fixar as raízes obtidas do ITI e conferir a origem | A fazer |
| 3 | Prova real: assinar um PDF com um certificado A1 ICP-Brasil de **teste** e passar pelo validador do ERP | Um certificado ICP de teste (decisão do dono) | Bloqueado |
| 4 | Assinatura individual por participante (e-CPF): baixar, assinar, subir, validar | Passo 3 e o serviço de validação do ERP publicado | A fazer |

Hoje o portal assina com a cadeia autoassinada gerada pelo próprio sistema, que **não é ICP-Brasil**.
Um e-CNPJ A1 instalado pelo cliente passa a ser usado como certificado padrão, mas a assinatura só será
considerada ICP-Brasil depois dos passos 2 e 3.
