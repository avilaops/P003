# Contratos • Fluxo individual no ERP e portal

## Autoridade e objetivo

Implementa o componente 3 de [Assinatura ICP individual](../../telas/servicos/contratos/referencias/ASSINATURA-ICP-INDIVIDUAL.md), já solicitado pelo usuário com execução contínua. Esta decomposição não substitui o requisito integral nem declara homologação. Base de integração: `fad8ad25f79633b888d31bfa2e28cccc24c290ba`.

Cada participante identificado assina todos os documentos congelados com seu próprio e-CPF. O ERP preserva a revisão comercial, os consentimentos e a trilha DocuSeal; conclusão do portal permanece diferente de conclusão ICP. Não recebe material de chave privada pessoal.

## Alternativas e decisão de implementação

1. Confiar no selo DocuSeal ou A1 da empresa conflita com o requisito individual e foi descartado.
2. Alterar os snapshots históricos para aparentar ICP destruiria sua proveniência e foi descartado.
3. Acrescentar um agregado tipado separado ao contrato existente, com snapshots imutáveis e estado operacional transacional, preserva o legado e permite validar concorrência. É a escolha de implementação dentro do fluxo individual já aprovado; não uma nova escolha atribuída ao usuário.

## Persistência e limites

`commercial_contracts.signature_policy` identifica `legacy_docuseal` ou `icp_each_participant`. A migração classifica somente os existentes como legados. O caminho de geração novo deve selecionar explicitamente a política individual; nenhum JSON do chamador pode reduzi-la. Política, confiança e participantes são congelados antes de criar o submission ou convite externo.

As novas tabelas usam tenant explícito, RLS forçada e FKs compostas. Envelope, participantes, documentos base, revisões e bundles são registros imutáveis. Estado operacional, leases, tentativas e sessões ficam separados. CPFs normalizados e válidos são cifrados com AES-256-GCM, chave própria de contratos e AAD que vincula tenant/envelope/participante. Não reutilizar o vault fiscal ou seu A1. DTOs comuns usam CPF mascarado; logs não contêm CPF, grant, sessão, PDF ou bundle.

Limites fixos: 1 a 10 participantes, 1 a 10 documentos, base até 20 MiB, candidato até 32 MiB, dois uploads pendentes por participante e 1 GiB de revisões por envelope. Reservas de bytes são atômicas sob lock do envelope; aceitação mantém os bytes contabilizados, falha conserva quarentena por sete dias. Revisões aceitas e provas não entram na limpeza de releases.

## Operações e estados

Fases do agregado: `portal_pending`, `preflight_pending`, `personal_signing`, `completed`, `blocked`. O estado do provider continua separado. Não há transição direta de portal para `completed`.

Ao concluir o portal, reconciliar origem/submission/identidades e todos os PDFs finais, gravar os bytes exatos e hashes, e congelar a lista. Só o preflight aceito de todos os documentos libera o primeiro participante. Participante atual e head de cada documento têm versões explícitas. Todos os documentos de uma etapa devem ser aceitos antes da seguinte.

Upload vincula sessão, envelope, participante, documento, hash do pai e revisão esperada. Reserva quota e cria job/outbox na mesma transação. Worker reivindica lease limitado com token e prazo; uma conclusão tardia ou repetida deve falhar no CAS. Só aceita resultado após verificar e preservar o bundle completo, seu hash, a identidade esperada, pai/candidato, política, confiança e evidência tipada. Falha de persistência reverte o avanço. Repetição não duplica prova nem avança outra etapa.

Não usar eventos administrativos para assinar em nome do participante. Delegação exige novo fluxo autorizado antes do congelamento; identidade congelada nunca é editada depois.

## Fronteira com o serviço

Cliente Rust usa TLS real e chave HMAC dedicada ao serviço existente, frames `AVILA-CV1` e resposta `AVILA-CVB1`. Limita corpo e prazos antes da decodificação. Confere MAC externo e interno, schema, contexto, partes/hashes e compromisso `typed_evidence_set_bound`, sem interpretar PDF/DER no ERP. Apenas perfil de confiança produtivo fixado; `synthetic_not_icp` é exclusivamente teste. `invalid`, `indeterminate` e `unsupported`, conteúdo incompleto ou exceção bloqueiam avanço.

O chamador usa horário UTC observado confiável e nonce novo por job; não aceita horário indicado pelo navegador. Configuração ausente mantém indisponível o fluxo novo, com mensagem explícita e sem fallback legado.

## Acesso do titular

Grant aleatório opaco de uso único e expiração curta; somente hash é armazenado. Troca por sessão própria estreita e revogável, vinculada ao participante e às verificações do portal. Não criar identidade/membership ERP. Cookie HttpOnly, Secure, SameSite e proteção de origem nos comandos; respostas privadas sem cache. Grant não comprova ICP, apenas acesso.

Sem verificação real de canal/2FA exigida pelo portal, não liberar sessão apta a enviar assinatura. Não confiar em flags fornecidas pelo navegador. Sessão cruzada, revogada ou de etapa futura não pode baixar/enviar documento. A política de autenticação ERP/SSO existente não muda.

## Telas e pacote

Administração exibe política, avanço por pessoa/documento, hashes, bloqueios e pendências; preserva permissões e revisão. Titular baixa somente head atual, vê instrução de assinatura local e devolve PDF. Não oferecer upload de PFX/PIN/senha. Usar componentes responsivos existentes e texto com separador `•`.

Pacote ICP requer todos os heads finais e todos os bundles correspondentes. Não usa primeiro PDF, preview ou documento parcialmente assinado. Manifesto liga arquivos, identidade mascarada e provas por hash. Comprovantes posteriores permanecem outros documentos, sem alterar PDFs assinados. Componente 4 complementará distribuição, retenção/restauração e imagens; a trava de pacote incompleto pertence a este fluxo.

## Verificação e ativação

Testes unitários e PostgreSQL real sob papel sem BYPASSRLS: invariantes, CPF/cifra, três titulares e dois documentos, quotas, replay, leases expirados, workers tardios, falha de bundle/persistência, sessões/tenant cruzados e pacote incompleto. Testes de codec cruzam fixtures do serviço; testes browser cobrem teclado, mobile e nenhum segredo pessoal recebido.

Executar fmt, clippy, testes, contratos OpenAPI, lint/typecheck/build web e gates CI disponíveis. Uma revisão independente ao terminar o componente completo, antes de integração. Não publicar ou convidar pessoas reais por estes testes.

Homologação real continua pendente e deve permanecer bloqueio explícito de ativação: PDF da versão instalada do DocuSeal, preflight e ao menos duas assinaturas pessoais sucessivas dos titulares autorizados. Servidor indisponível não impede escrever/testar código; não autoriza inventar homologação.
