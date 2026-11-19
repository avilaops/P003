# NFC-e

[Todas as telas](../../../README.md) · [Fiscal](../README.md)

Consultar e acompanhar os documentos de consumidor do fluxo fiscal.

**Onde acessar:** `/fiscal/nfce`.

## O que aparece na tela

- Documentos do modelo 65 em páginas, com filtros por ambiente, situação e período
- Rascunhos e emissões autorizadas, rejeitadas ou canceladas
- Pendências do CSC e da numeração do modelo 65 no ambiente da empresa
- Dados e pagamentos do documento

## O que você pode fazer

- Consultar documentos
- Preparar o XML assinado e transmitir ou consultar a NFC-e pelo modelo e ambiente da empresa
- Baixar o XML e gerar o DANFE NFC-e térmico a partir do protocolo autorizado
- Consultar o histórico de cancelamento e reconciliar um evento cujo retorno não foi confirmado

## Regras e limites

A venda do PDV e a autorização da NFC-e são distintas. Certificado, configuração de NFC-e e demais exigências do ambiente continuam necessários.

O motor TypeScript valida a assinatura e o XSD do XML com o suplemento de QR Code. O comprovante térmico traz itens, pagamentos, troco e QR. A emissão offline permite baixar o XML assinado e imprimir o cupom com a indicação de autorização pendente. Quando o serviço volta, o operador transmite a mesma chave e o comprovante autorizado recebe o protocolo. Os endereços de São Paulo são específicos do modelo 65 e do ambiente. [WebServices da SEFAZ-SP](https://portal.fazenda.sp.gov.br/servicos/nfce/Paginas/WebServices.aspx) • [Manual do DANFE NFC-e](https://portal.fazenda.sp.gov.br/servicos/nfce/Downloads/Manual%20de%20Especificacoes%20Tecnicas%20do%20DANFE%20NFC-e%20QR%20Code%20%20-%20Versao%204.1.pdf)

## Referências para manutenção

Guia conferido no código de 12/11/2026. As ações dependem das permissões e da configuração da empresa. Relatos técnicos antigos descrevem a etapa em que foram escritos.

- [fiscal-screen](../../../../apps/web/src/features/fiscal/fiscal-screen.tsx)
- [nfe-draft-editor](../../../../apps/web/src/features/fiscal/nfe-draft-editor.tsx)
