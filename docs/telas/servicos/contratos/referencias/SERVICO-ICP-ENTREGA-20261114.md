# Contratos • Entrega do serviço privado ICP

Estado em 14/11/2026 • implementação do componente de validação, sem ativação
de assinaturas reais. Este registro não encerra o fluxo completo do ERP.

## Código e evidências

- Repositório: avilaops/P003 • [PR 214](https://github.com/avilaops/P003/pull/214).
- Revisão de código validada: `209aa44a0a2be8df93ea5dc4e5154a574edd2326`.
- [CI 43621368975 aprovada](https://github.com/avilaops/P003/actions/runs/43621368975).
- Integrado na main: `7f4c26a97c839c5938bdddefb7446fdbe70c2074`.
- Publicação do serviço: não realizada; nenhuma rota, convite ou assinatura ativada.

O job de política confirmou núcleo offline 77/77, wheel Linux 79/79 e imagem
restrita 79/79, sem casos ignorados. Verificador do serviço: 32,314 s.
API: 531 aprovados, um ignorado e sete auxiliares aprovados. Web, fiscal,
schema, política e gate final passaram; os jobs exclusivos de execução completa
ou imagem/browser foram ignorados pelas condições existentes do workflow.
Da criação da execução ao último job: 533 s (8 min 53 s). Esse tempo é CI,
não publicação. O release existente é acionado por tag ou comando explícito.
O percurso sintético completo por TLS, Unix e subprocesso offline retornou um
bundle autenticado; o teste também comprovou recusa de confiança sintética na
CLI produtiva e acesso negado aos arquivos HMAC/TLS e memória do gateway pelo
coletor. O worker permaneceu sem rede, capabilities e montagem de segredos.

Hash do bundle sintético do percurso:
`2cf941cb3b37a2fa47a8876470d5260255992dbf308bf228bdefe213086fe34f`.
Esse hash identifica apenas a evidência sintética daquela execução.

O commit sintético testado `8855bf7e975339c5501c3b0eacee5f495ff280b5`, o head da
PR e a main integrada têm a mesma árvore
`638fcf2cc3f2e3988fca74e2dac959028850f73c`. O checkout local foi atualizado por
fast-forward. A branch temporária integrada foi removida após conferir árvore,
head e merge, preservando antes seus nove commits em um bundle Git verificado.
Nenhuma outra branch, worktree ou arquivo não rastreado do usuário foi removido.

Os vereditos continuam `accepted`, `invalid`, `indeterminate` e `unsupported`.
Falha de rede, erro do parser ou ausência de evidência nunca autoriza aceite.
O instante observado não prova validade futura nem carimbo de tempo qualificado.

## Organização do componente

- `apps/contract-signature-service` • gateway TLS/HMAC, worker offline,
  descoberta restrita, canal Unix, subprocessos, bundle e testes.
- `deploy/contracts-validator` • imagem, Compose sem portas publicadas,
  origens revisadas, perfil seccomp fixado, licença e instruções privadas.
- `scripts/contracts/verify-signature-service.py` • wheel e testes reais Linux/Docker.
- `_validate-project.yml` • validação obrigatória no workflow reutilizável existente.

O componente reutiliza o núcleo 0.2.0. A API HTTP é privada e aceita somente
POST `/internal/v1/preflight` e `/internal/v1/increment`, autenticados com HMAC.
Não é um endpoint público para navegadores e não possui acesso a banco, DocuSeal,
cofre fiscal, certificado A1 da Ludus ou chaves dos titulares.

## Revisão e regressões

Uma revisão independente apontou quatro problemas importantes, corrigidos com
testes que falharam antes da alteração e passaram depois:

1. Descendentes podiam mudar sessão/grupo ou sinalizar o supervisor. O bootstrap
   aplica seccomp antes do código isolado, restringindo esses caminhos e namespaces;
   o supervisor fica não dumpable. O teste usa SIGCONT para comprovar a recusa
   sem parar o próprio runner durante a fase que reproduz o defeito.
2. O coletor podia abrir segredos do gateway pelo filesystem. Landlock restringe
   as leituras ao runtime/configuração pública; o percurso em container tenta abrir
   os arquivos reais de teste e a memória do pai e exige acesso negado.
3. O bundle permitia trocar categorias ou acrescentar evidência negativa após
   produzir o relatório. O worker agora inclui `evidence_set` no relatório
   canônico, vinculando o conjunto tipado exato; encoder, IPC e SDK o exigem.
4. O download podia exceder o budget agregado antes de ser descartado. O limite
   restante acompanha a consulta, a leitura e a saída supervisionada, com reserva
   conservadora para falhas parciais.

O Linux também revelou duas incompatibilidades do harness: remoção automática
do socket pelo Python 3.13 e leitura de `pyvenv.cfg` necessária ao reexec.
Foram corrigidas sem desligar isolamento. A ausência de montagem de segredos é
comprovada pelo Docker e a negativa de leitura é verificada separadamente.

## Decisões e custo se precisarem mudar

1. Bundle binário com relatório, DER e confiança pública • o JSON de 256 KiB não
   comporta o conjunto de evidências. Custo: o cliente ERP precisa implementar
   esse codec antes de consumir o relatório interno existente.
2. Cada consulta em subprocesso próprio, até três segundos incluindo DNS/corpo •
   timeout de socket não limita uma resposta gotejada. Custo: criação de processos,
   limitada a doze consultas e uma requisição ativa.
3. Orquestração e budgets ficam no gateway; fetcher faz uma consulta • custo:
   não chamar o fetcher sem o supervisor de tempo/bytes.
4. Worker produz JSON ainda não selado e não recebe HMAC • gateway confere
   contexto/veredito antes de selar. Custo: não tratar saída arbitrária do worker
   como relatório autenticado sem as verificações do contrato.
5. WorkerClient conserva o AuthenticatedRequest e os bytes originais • custo:
   o chamador não pode reencodar o frame ou inventar outro instante observado.
6. Injeção de coletor/relógio existe somente em código de teste • custo:
   não expor esses mecanismos como flag, ambiente ou configuração produtiva.
7. PEMs públicos e perfil seccomp têm checkout LF e proveniência por hash •
   custo: alterações intencionais nesses bytes exigem revisão e novos hashes.
8. Compromisso tipado `evidence_set` usa a extensibilidade de CheckResult do
   núcleo 0.2.0 • custo: relatório bruto sem o compromisso não vira bundle;
   o empacotador não pode inventá-lo depois da validação.
9. Landlock ABI >= 3 e seccomp são obrigatórios, sem fallback permissivo • custo:
   runtime Linux compatível e manutenção da lista de leituras do interpretador.
10. Perfil externo Moby é fixado sem alterações, com licença e hash • custo:
    atualização de upstream exige revisão; não trocar por seccomp unconfined.
11. Downloads com falha consomem a reserva atribuída • custo: uma sequência de
    falhas pode esgotar o budget e resultar indeterminada mais cedo.
12. Usar execuções completas comprovadas como evidência, sem repetir uma suíte
    apenas para passar pelo wrapper de bookkeeping • custo: preservar comandos,
    resultados e respectivos logs/commits para auditoria.
13. Integrar pelo fluxo GitHub já autorizado sem repetir o menu de escolhas •
    custo: a autorização precisa continuar válida e o head/base/checks devem ser
    conferidos antes de cada merge. Não foi usado bypass de política.
14. Remover apenas a branch própria após squash comprovado por igualdade de árvore,
    mesmo sem ancestralidade do head • custo: manter prova de merge e preservar
    o histórico em bundle verificado antes de remover a referência local.

## Limites da entrega e próximos componentes

- Isolamento Linux/Docker exige execução real; Windows ou testes com mocks não
  substituem essa evidência. A presente entrega registra os dois tipos separadamente.
- Disponibilidade atual das autoridades e assinaturas pessoais reais permanecem
  na homologação; a allowlist inicial registra proveniência, não disponibilidade.
- Integração Rust/BFF, política e participantes congelados, RLS, quotas, sessões,
  2FA, leases/CAS, replay, armazenamento append-only e pacote de todos os documentos
  continuam pendentes. Pagamentos posteriores não alteram os bytes já assinados.
- A revisão deste serviço examinou o acoplamento ao núcleo; não substitui uma
  auditoria criptográfica integral nem um veredito ITI.
- Comprometimento do host e alterações administrativas de mounts/rotas ficam
  fora da garantia dos containers. A hipótese de espera ilimitada por cabeçalhos
  iniciais foi descartada após conferir o keepalive do aiohttp instalado.
- A recuperação do ERP e dos dados reais é uma frente operacional separada.
  Código integrado, CI aprovado e aplicação publicada devem ser comprovados
  individualmente antes de declarar o fluxo operacional.

Não houve observações menores novas da revisão deste componente. A observação
anterior do transporte sobre JSON equivalente não canônico continua documentada
na entrega 0.2.0; o MAC protege os bytes originais e duplicatas são recusadas.
