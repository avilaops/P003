# Contratos • Validador privado

Componente em validação • não ativa o fluxo do ERP nem substitui a homologação
dos PDFs e certificados reais dos titulares. Nenhuma publicação é feita pelo
verificador de CI. O serviço não acessa banco, cofre fiscal ou DocuSeal.

## Imagem e configuração

Uma imagem contém gateway e worker. O Dockerfile fixa Python 3.13 slim Bookworm
pelo digest público `sha256:a5a7017efc5969e00ae2b91c8eb0631049a569652aa4ffc4501769049ae45c72`,
consultado no registro oficial em 14/11/2026. O build usa uv 0.12.24 e o lock
versionado, sem instalações editáveis. O contexto permite somente código e
metadados dos dois pacotes; testes, arquivos locais e credenciais ficam fora.

Antes de implantar, a imagem precisa ser construída a partir do commit aprovado,
testada e disponibilizada em registro privado. Configure `VALIDATOR_IMAGE` com
`registro/imagem@sha256:...`, nunca com uma tag mutável. A publicação dessa imagem
e a ligação ao runtime do ERP ainda dependem da recuperação da hospedagem.

`VALIDATOR_PUBLIC_CONFIG` aponta para um diretório contendo:

- `roots.pem` • cópia exata de `deploy/fiscal/icp-brasil-roots.pem`.
- `intermediates.pem` • cópia exata de `deploy/fiscal/icp-brasil-intermediates.pem`.
- `evidence-origins.json` • configuração revisada deste diretório.

Os hashes de proveniência verificam os bytes PEM com LF. As duas fontes fiscais
têm regras de checkout LF. Não alterar certificados ou ampliar confiança para
resolver ausência de evidências.

As regras iniciais foram extraídas de AIA/CDP dos 183 certificados públicos já
versionados: 23 origens e 48 caminhos exatos, sem liberação genérica de `/`.
Não houve consulta externa a essas URLs nem prova de disponibilidade atual.
Outros emissores podem permanecer indeterminados até revisão e homologação das
respectivas origens; um PDF recebido nunca cadastra sua própria permissão de rede.

`VALIDATOR_SECRETS` é um diretório privado somente do gateway, com arquivos
locais de propriedade do UID 10001 e sem leitura de grupo/outros:

- `hmac.json` • `schemaVersion: avila-validator-keys/1` e `keys`, com um ou dois
  IDs e valores base64 de chaves dedicadas aleatórias de 32 a 64 bytes.
- `tls.pem` • certificado/cadeia TLS do nome privado usado pelo cliente.
- `tls-key.pem` • chave TLS correspondente, sem senha interativa.

Não reutilizar chaves de sessão, certificados de clientes ou A1 da Ludus.
Não colocar segredos no Git, imagem ou variáveis do Compose. O launcher não
oferece opção para confiança sintética nem para desativar TLS.

## Rede e retenção

O Compose não publica portas. O gateway precisa ser ligado à rede privada do
cliente autorizado, que verifica TLS e autentica com HMAC; ele coleta apenas
evidências de destinos aprovados e públicos. O worker usa `network_mode: none`,
rootfs somente leitura e UID separado. O canal Unix tem diretório 0750 e socket
0660; cliente e servidor conferem os UIDs do peer.

Uma requisição ativa por processo, upload até 10 s e execução até 40 s; até 12
consultas em 12 s, três segundos por subprocesso de rede. PDFs são processados
offline, com limites de CPU/memória/saída e cancelamento do grupo de processos.
Ambos os containers usam init, sem capabilities e com no-new-privileges.

Os subprocessos exigem Landlock ABI 3 ou superior e seccomp, em Linux x86-64
ou aarch64. O launcher recusa ambientes sem esse suporte. Após criar o grupo
supervisionado, o bootstrap restringe leitura ao runtime e à configuração pública;
segredos e `/proc` ficam inacessíveis. O filtro herdado pelos descendentes bloqueia
mudança de sessão/grupo, namespaces, sinais e manipulação da memória do supervisor.
O supervisor fica não dumpable; somente pipes e devnull são herdados pelo filho.

O perfil externo `seccomp.json` é uma cópia inalterada do padrão público do Moby,
fixada por commit e hash em `seccomp-provenance.json`, com a licença preservada.
Esse padrão já permite as chamadas Landlock; o filtro adicional do bootstrap
impõe as restrições específicas do trabalho. Não usar seccomp unconfined.

O limite restante de bytes acompanha cada consulta até a leitura HTTP e a saída
do subprocesso. Falhas podem ter consumido bytes: reserva-se o teto da consulta
antes de iniciá-la, devolvendo capacidade somente após uma resposta bem-sucedida.
Isso pode deixar uma consulta indeterminada mais cedo, preservando o limite global.

Não há retenção de PDF ou DER no serviço. O volume `channel` contém somente o
socket e o lock, sem releases ou artefatos de build. Logs limitados a dois
arquivos de 5 MB por container, sem dados do pedido. O futuro workflow do ERP
precisa guardar e conferir o bundle antes de avançar estado ou head.

O worker acrescenta ao relatório canônico o check `evidence_set`, que compromete
o hash do conjunto tipado exato já normalizado. Encoder, IPC e SDK exigem esse
compromisso; não podem acrescentar evidências ou trocá-las de categoria depois
da validação. Um relatório bruto do núcleo sem esse check não vira um bundle.

Referências: [Landlock](https://docs.kernel.org/userspace-api/landlock.html),
[seccomp](https://man7.org/linux/man-pages/man2/seccomp.2.html) e
[PR_SET_DUMPABLE](https://man7.org/linux/man-pages/man2/PR_SET_DUMPABLE.2const.html).

## Verificação

O job reutilizável `_validate-project.yml` constrói o wheel e executa
`scripts/contracts/verify-signature-service.py --docker`. O verificador exige
Linux/Docker, roda os casos de Unix/rlimits sem skips e usa containers com as
restrições reais. Monta explicitamente um harness sintético fora da imagem para
testar TLS → gateway → Unix → subprocesso offline → bundle autenticado. A coleta
desse percurso usa CRLs sintéticas montadas; o coletor de produção e seus budgets
têm testes próprios. A CLI produtiva deve rejeitar as mesmas raízes sintéticas.

São removidos somente containers, volume e tag temporários que a execução criou.
Não há prune global, deploy ou acúmulo de imagens no servidor de produção.
O relatório de CI contém hashes e resultados, sem certificados pessoais,
chaves ou PDFs. Testes sintéticos não são validação ITI nem homologação real.
