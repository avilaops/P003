# CI/CD • tempo e retenção • 17/11/2026

## Tempos observados

A [publicação de c8796d9b](https://github.com/avilaops/P003/actions/runs/44121476204) durou aproximadamente 34 minutos. As etapas executam em paralelo ou têm dependências; seus tempos não devem ser somados como se fossem sequenciais.

| Etapa | Tempo |
|---|---:|
| API, incluindo verificações nativas e integração TypeScript | 17min26s |
| Validação e build web | 2min36s |
| Maior grupo de testes de navegador | 8min26s |
| Imagem web | 50s |
| Ativação no servidor | 2min59s |

O [CI anterior](https://github.com/avilaops/P003/actions/runs/44118753672) durou 11min21s. A publicação precedente durou 32min12s. São medições dessas execuções; não representam uma garantia de duração futura.

## Redução de trabalho duplicado

O classificador tratava `apps/api-ts` como infraestrutura desconhecida e acionava web, API nativa e fiscal. Agora alterações exclusivas dos módulos e testes da API TypeScript selecionam apenas a API. Nesse caso, o workflow executa typecheck e testes com PostgreSQL, sem compilar Rust ou comparar novamente as implementações nativas.

Mudanças em Rust, migrações, consultas compartilhadas, dependências globais, infraestrutura desconhecida e na integração da API mantêm a verificação nativa. Publicações e regressões completas também a mantêm. O padrão é conservador quando a informação de escopo está ausente. Não foi criado um novo workflow de entrada.

As verificações locais das regras e workflows passaram em 52 testes rápidos. A otimização só passa a reger os próximos PRs depois da integração na main; não altera o tempo já gasto nas execuções acima.

## Artefatos no servidor

O estado consultado identificou produção em `c8796d9bc1383b7e5535114ed6e332c27a139746` e rollback em `32f196818b4b1fcb1d3b5a33a70ce006f82f00c5`. Já existiam apenas esses dois diretórios de release.

A auditoria encontrou pacotes antigos fora desses diretórios. Foram removidos inicialmente 16 diretórios de artefatos de deploy, totalizando 3.980.186.803 bytes. O plano foi conferido antes da gravação, identificado por hash e aplicado sob o mesmo bloqueio usado pelo deploy. Foram protegidos os identificadores de produção e rollback e os caminhos vinculados a containers; diretórios desconhecidos e arquivos fora da lista reconhecida foram preservados.

Após conferir a identidade do recibo de um último pacote legado, foi removido mais um diretório com 195.298.776 bytes. O total removido foi de 17 diretórios e 4.175.485.579 bytes. Os dois diretórios de artefatos ficaram vazios, e produção e rollback permaneceram preservados.

O espaço livre observado após a limpeza foi de 8,0 GB no volume da aplicação. Outros processos também operam no servidor, portanto a variação total do disco não deve ser atribuída exclusivamente à limpeza. Dados, mídias, volumes e backups de negócio não fizeram parte da remoção. As cinco aplicações do conjunto ERP estavam saudáveis na conferência posterior.

Os 33 artefatos do último workflow somaram 94.166.256 bytes no GitHub. O maior, o build web, expira em um dia; evidências de navegador expiram em sete dias. Esses artefatos remotos não ocupam o disco do servidor de produção.
