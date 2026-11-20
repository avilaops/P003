# Contratos • fixtures de transporte

`preflight.json` e `increment.json` são vetores de interoperabilidade gerados por `scripts/contracts/generate-wire-vectors.py` usando o codec Python real. Os relatórios são modelos construídos e os PDFs são fictícios e inválidos. Um resultado `accepted` nestes vetores não comprova uma assinatura ICP-Brasil.

`https_fixture.py` usa somente a biblioteca padrão do Python para servir esses modelos em HTTPS no loopback e conferir o HMAC recebido. Os testes Rust verificam certificado TLS, contexto, integridade, limites, redirecionamento, falhas de rede e prazo. Python 3 deve estar disponível; `ERP_CONTRACT_TEST_PYTHON` pode indicar seu executável nos testes.

`tls-test-ca.pem`, `tls-test-server.pem` e `tls-test-server-key.pem` são material **sintético e exclusivo de testes**, válido entre 2025 e 2035. A chave do servidor é pública no repositório e nunca deve ser usada fora deste servidor de teste. A chave privada da CA não foi armazenada. Os certificados possuem nomes explícitos de teste e SAN restrito a `localhost` e `127.0.0.1`; não são certificados de assinatura PDF nem ICP-Brasil.

O Dockerfile da API copia somente o binário de produção e as raízes públicas ICP. Este diretório e a chave TLS de teste não são copiados para a imagem; os testes Rust são compilados somente com `cfg(test)`.
