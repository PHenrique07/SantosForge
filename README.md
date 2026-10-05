# SantosForge

Use os **modelos gratuitos do [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi)** (Llama, Gemini, Qwen, DeepSeek, GLM…) direto no **seletor de modelos do GitHub Copilot Chat** — inclusive no modo Agente.

Na barra de status aparece **qual LLM respondeu de verdade** (o FreeLLMAPI pode fazer fallback) e **quantos tokens** foram gastos:

```
✨ groq/llama-3.3-70b-versatile · 1.2k↑ 340↓ · Σ45k
```

Passe o mouse para ver detalhes (tentativas de fallback, duração, consumo da sessão/acumulado e o orçamento do free tier, quando disponível). Clique para ver o consumo por modelo.

## 1. Rodar o FreeLLMAPI

Escolha uma opção (detalhes no [guia de instalação](https://github.com/tashfeenahmed/freellmapi/blob/main/docs/en/install/01-install.md)):

- **Desktop:** baixe o app para Windows/macOS em [Releases](https://github.com/tashfeenahmed/freellmapi/releases/latest).
- **Docker:** veja a seção *docker compose* do guia.

Depois, no painel (`http://localhost:3001`):

1. Adicione pelo menos uma chave gratuita (ex.: [Google AI Studio](https://aistudio.google.com/apikey) ou [Groq](https://console.groq.com/keys)).
2. Na página **Keys**, copie a **chave unificada** (`freellmapi-…`).

## 2. Instalar a extensão

1. VS Code → Extensões → `...` → **Install from VSIX…** → escolha `santosforge-0.0.1.vsix`.
2. Vai aparecer um aviso pedindo o token → cole a chave `freellmapi-…`.
   (Ou `Ctrl+Shift+P` → **SantosForge: Definir token do FreeLLMAPI**.)
3. No Copilot Chat, abra o seletor de modelos → **Gerenciar modelos** → habilite os modelos **SantosForge**.

> Requer VS Code 1.104+ com GitHub Copilot Chat.

## Configurações

| Configuração | Padrão | Descrição |
|---|---|---|
| `santosforge.apiUrl` | `http://localhost:3001/v1` | URL do FreeLLMAPI (troque o host para usar em rede) |
| `santosforge.onlyReadyModels` | `true` | Listar só modelos que podem responder agora |
| `santosforge.maxModels` | `60` | Limite de modelos no seletor |
| `santosforge.enableToolCalling` | `true` | Necessário para o modo Agente |
| `santosforge.showModelInResponse` | `false` | Adiciona uma linha com modelo/tokens no fim de cada resposta |

## Comandos

- **SantosForge: Definir token** / **Remover token salvo**
- **SantosForge: Testar conexão**
- **SantosForge: Recarregar lista de modelos**
- **SantosForge: Ver uso de tokens** / **Zerar contador de tokens**

O token fica no **SecretStorage** do VS Code (criptografado), nunca no `settings.json`.

## Desenvolvimento

```bash
npm install
npm run compile     # ou F5 no VS Code para abrir o Extension Host
npm run package     # gera santosforge-0.0.1.vsix
```

Logs: painel **Output → SantosForge**.

## Observações

- A contagem de tokens vem do próprio FreeLLMAPI (`usage`). Se o provedor não informar, é feita uma estimativa (~4 caracteres/token) marcada com `~`.
- O "orçamento free tier" usa o endpoint de painel `/api/free-tier`; se ele exigir login no painel, a informação simplesmente não aparece.
- O FreeLLMAPI é para uso pessoal/experimental — respeite os termos de cada provedor.
