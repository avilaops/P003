# Contratos • cliente HTTPS do validador

O cliente Rust consome o serviço privado de validação. Esta integração de transporte não ativa convites nem comprova homologação de titulares reais. O fluxo individual completo permanece em implementação na PR 216.

## Configuração da API

Todos os parâmetros ausentes deixam o cliente indisponível. Se algum estiver presente, os cinco primeiros são obrigatórios. Valor vazio, segredo inválido ou confiança incompatível interrompem a inicialização, sem fallback legado.

| Variável | Conteúdo |
|---|---|
| `ERP_CONTRACT_VALIDATOR_URL` | Origem HTTPS do serviço, opcionalmente com porta; sem credenciais, caminho adicional, query ou fragmento |
| `ERP_CONTRACT_VALIDATOR_KEY_ID` | Identificador da chave HMAC ativa, existente no keyring |
| `ERP_CONTRACT_VALIDATOR_KEYRING_FILE` | Arquivo privado JSON no mesmo formato usado pelo gateway |
| `ERP_CONTRACT_VALIDATOR_TLS_CA_FILE` | PEM público da CA TLS explicitamente autorizada para o serviço |
| `ERP_CONTRACT_VALIDATOR_ROOTS_FILE` | PEM público das raízes ICP autorizadas e fixadas no registry revisado |
| `ERP_CONTRACT_VALIDATOR_INTERMEDIATES_FILE` | PEM público de intermediárias, opcional; participa da identidade da confiança |

O keyring utiliza `schemaVersion` igual a `avila-validator-keys/1` e um objeto `keys` com um ou dois pares de identificador e chave em base64. Cada chave decodificada tem 32 a 64 bytes. O arquivo não tem campo `active`: a seleção vem de `KEY_ID`. Identificadores e campos duplicados, campos extras e entradas inválidas são recusados, inclusive a chave inativa durante rotação.

Arquivos devem ser regulares, com o componente final sem symlink e dentro dos limites: keyring 4 KiB, CA TLS 256 KiB e raízes mais intermediárias 4 MiB. No Unix, o segredo não pode ter permissões para grupo ou outros; no Linux também deve pertencer à identidade efetiva do processo, obtida pelos metadados de `/proc/self`. O inode aberto é conferido com o inspecionado. Diretórios de configuração devem ser controlados pelo administrador. No Windows, as ACLs devem restringir o segredo à conta do serviço. Diagnósticos não incluem caminhos, conteúdo de chaves, CPF ou documentos.

## Limites e confiança

O cliente aceita somente HTTPS com TLS 1.2 ou superior e a CA explicitamente configurada. Não utiliza proxies, redirecionamentos, descompressão automática ou raízes TLS públicas como fallback. A CA TLS não substitui as raízes ICP usadas na prova.

A conexão tem prazo de três segundos e a operação HTTP de 55 segundos. Somente status 200 com os cabeçalhos previstos é aceito. O `Content-Length` canônico deve estar presente e entre um byte e 40 MiB antes da leitura do corpo; cada chunk é conferido e truncamento é recusado. O corpo de envio é transferido sem uma segunda cópia integral pelo codec.

MAC externo, MAC interno, hashes de todas as partes, contexto, nonce, identidade, pai e candidato, política, confiança produtiva, relógio e evidência tipada são conferidos antes de construir `VerifiedBundle`. O objeto preserva bytes e cabeçalhos de prova. Vereditos negativos continuam negativos e não autorizam avanço. Falhas de rede e validação retornam erro opaco; não existe resposta aceita em cache ou interpretação de PDF/DER remoto nesta API.

## Validação

Os testes de transporte usam modelos construídos com HMAC e TLS sintéticos, servidor HTTPS local e Python padrão. Verificam interoperabilidade e comportamento de falhas; não substituem PDF real, certificados pessoais ou a homologação DocuSeal exigida em [Assinatura individual](ASSINATURA-ICP-INDIVIDUAL.md).
