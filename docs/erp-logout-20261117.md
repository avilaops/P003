# ERP • saída direta para avilaops.com

O responsável definiu que a saída do ERP deve encerrar a sessão e terminar em `https://avilaops.com/`, sem a tela informativa ou de confirmação do Auth. Este contrato de 17/11 atualiza o comportamento anterior descrito no README de implantação.

## Percurso

O botão Sair envia POST de mesma origem, limpa os cookies locais e cria o marcador cifrado HttpOnly de dois minutos. A continuação GET valida esse marcador, avança sua fase e envia automaticamente um formulário POST ao `end_session_endpoint` do Auth descoberto pelo servidor.

A resposta de continuação contém CSP com nonce, destinos de formulário restritos ao Auth, ERP e site final e `Referrer-Policy: origin`. A exceção de headers aplica-se apenas a esse endpoint. As demais páginas mantêm suas políticas existentes.

O Auth aceita esse POST sem confirmação apenas com issuer de produção, Origin ERP exato, cliente `erp-next` e callback cadastrado exato. Cliente e retorno ativo são revalidados antes de qualquer efeito. GET ou origem externa não encerram sessão.

O callback consome o marcador e retorna ao site fixo. Não apaga uma sessão iniciada depois do pedido de saída. Falha no Auth permanece uma falha e não comprova logout global.

## Evidência local

• Auth: 21 casos de logout, typecheck e lint aprovados; PR 65 integrado na revisão 35eafcd025e44898b120e2b41ec879b80f3cc2d2.
• ERP: três casos de navegação aprovados, incluindo método POST, Origin conservado, CSP/nonce, retorno ao site e limpeza dos rascunhos.
• ERP em build de produção: 14 casos de cookies, sessão, origem e políticas aprovados; build, tipos e lint aprovados.
• Quatro casos de acabamentos em 320/390 px aprovados após preparar no teste os endpoints de cliente e tabelas usados pelo editor.
• Contratos de verificação: 45 casos aprovados.

A evidência local e a integração de código não comprovam ativação. As publicações e o percurso real após implantação são conferidos separadamente. Nenhum teste enviou documentos reais ou utilizou uma sessão pessoal para logout.
