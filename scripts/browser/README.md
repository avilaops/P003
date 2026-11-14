# Automação do Brave

Scripts de operação do navegador ficam nesta pasta. Capturas temporárias ficam no diretório temporário do Windows.

## Controle em segundo plano

`brave-order-session.mjs` usa o Brave instalado e o Playwright já presente em `apps/web`. Abre um perfil dedicado em `%LOCALAPPDATA%/AvilaOps/BraveOrderAutomation`, com depuração somente em `127.0.0.1:9336`. Não copia cookies de outro perfil nem lê valores de senhas. O login é feito pelo operador na própria janela.

Execute da raiz do repositório, no PowerShell:

```powershell
node scripts/browser/brave-order-session.mjs '{"action":"start"}'
node scripts/browser/brave-order-session.mjs '{"action":"minimize"}'
node scripts/browser/brave-order-session.mjs '{"action":"read"}'
```

Depois do login, a janela pode permanecer minimizada. Os comandos `fill`, `click`, `select` e `press` usam rótulos ou papéis acessíveis, sem mover o mouse ou o foco da janela em uso. Cada chamada executa somente a ação recebida. O comando padrão apenas lê a tela; não cria pedidos automaticamente. Use operações de gravação apenas para pedidos autorizados pelo operador.

## Alternativa de acessibilidade do Windows

`brave-order-ui.ps1` permite inspecionar a aba ERP já aberta por UI Automation. Essa alternativa pode mudar o foco e serve apenas para operação assistida em primeiro plano. Para tarefas em segundo plano, use o script Node.
