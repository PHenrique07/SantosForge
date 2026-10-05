import * as vscode from 'vscode';
import { BRAND, CMD, setting } from './brand';
import { FreeLLMApiClient, FreeLLMApiError } from './client';
import { getConfig, TokenStore } from './config';
import type {
  ChatCompletionRequest,
  OpenAIContentPart,
  OpenAIMessage,
  OpenAIModel,
  OpenAITool,
  OpenAIToolCall,
  RequestStats,
} from './types';
import { UsageTracker } from './usage';

/** Roteadores virtuais do FreeLLMAPI exibidos com nomes amigáveis no topo. */
const ROUTER_MODELS: Array<{ id: string; name: string; detail: string }> = [
  { id: 'auto', name: 'Auto (Recomendado · Melhor Escolha)', detail: 'Escolhe o melhor modelo disponível com cota' },
  { id: 'auto:smart', name: 'Auto (Mais Inteligente)', detail: 'Prioriza modelos com maior capacidade de raciocínio' },
  { id: 'auto:fast', name: 'Auto (Mais Rápido)', detail: 'Prioriza menor latência e maior velocidade de resposta' },
  { id: 'auto:reliable', name: 'Auto (Mais Confiável)', detail: 'Prioriza provedores com menor taxa de falhas' },
];

/** Estimativa simples: ~4 caracteres por token. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export class ChatModelProvider implements vscode.LanguageModelChatProvider {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

  private lastErrorNotice = 0;

  constructor(
    private readonly tokens: TokenStore,
    private readonly usage: UsageTracker,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  /** Força o VS Code a pedir a lista de modelos de novo. */
  refresh(): void {
    this._onDidChange.fire();
  }

  async createClient(): Promise<FreeLLMApiClient> {
    return new FreeLLMApiClient(getConfig().apiUrl, await this.tokens.get());
  }

  // ---------------------------------------------------------------------------
  // 1. Lista de modelos
  // ---------------------------------------------------------------------------
  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const cfg = getConfig();
    let apiToken = await this.tokens.get();
    if (!apiToken && !options.silent) {
      apiToken = await this.tokens.prompt();
    }
    if (!apiToken) {
      this.log.info('Sem token configurado; nenhum modelo listado.');
      return [];
    }

    const abort = new AbortController();
    const sub = token.onCancellationRequested(() => abort.abort());
    try {
      const client = new FreeLLMApiClient(cfg.apiUrl, apiToken);
      const list = await client.listModels(cfg.onlyReadyModels, abort.signal);
      const all = Array.isArray(list?.data) ? list.data : [];
      this.log.info(`GET /models -> ${all.length} modelos`);

      const routerIds = new Set(ROUTER_MODELS.map((r) => r.id));
      const result: vscode.LanguageModelChatInformation[] = ROUTER_MODELS.map((r) => ({
        id: r.id,
        name: r.name,
        family: 'freellmapi-auto',
        version: '1',
        detail: r.detail,
        tooltip: `${r.detail}. O modelo real usado aparece na barra de status.`,
        maxInputTokens: cfg.defaultContextWindow,
        maxOutputTokens: cfg.defaultMaxOutputTokens,
        capabilities: { toolCalling: cfg.enableToolCalling, imageInput: true },
      }));

      // Perfis auto:<nome> e fusion que o servidor retornar.
      for (const m of all) {
        if (!routerIds.has(m.id) && (m.id.startsWith('auto:') || m.id === 'fusion')) {
          routerIds.add(m.id);
          result.push(this.toInfo(m, cfg, 'freellmapi-auto'));
        }
      }

      const regular = all
        .filter((m) => m.id && !routerIds.has(m.id) && m.id !== 'auto')
        .filter((m) => !cfg.onlyReadyModels || !m.execution_status || m.execution_status === 'ready')
        .filter((m) => !isNonChatModel(m.id))
        .slice(0, cfg.maxModels);

      for (const m of regular) {
        result.push(this.toInfo(m, cfg));
      }
      return result;
    } catch (err) {
      this.handleError(err, !options.silent);
      return [];
    } finally {
      sub.dispose();
    }
  }

  private toInfo(m: OpenAIModel, cfg: ReturnType<typeof getConfig>, family?: string): vscode.LanguageModelChatInformation {
    const ctx =
      num(m.context_length) ?? num(m.context_window) ?? num(m.max_context_tokens) ?? num(m.max_input_tokens) ?? cfg.defaultContextWindow;
    const maxOut = num(m.max_output_tokens) ?? Math.min(cfg.defaultMaxOutputTokens, ctx);
    const provider = (m.platform as string) ?? (m.provider as string) ?? m.owned_by;
    const caps = Array.isArray(m.capabilities) ? m.capabilities.map(String) : Object.keys(m.capabilities ?? {});
    const vision = Boolean(m.vision ?? m.supports_vision ?? caps.some((c) => /vision|image/i.test(c)));

    let displayName = m.display_name ?? m.name ?? m.id;
    let detail = provider ? `${provider} · ${fmtCtx(ctx)}` : fmtCtx(ctx);

    // Embeleza nomes de slots virtuais conhecidos do FreeLLMAPI
    if (m.id === 'fusion') {
      displayName = 'Fusão (Painel de Modelos em Paralelo)';
      detail = 'Combina múltiplos modelos para criar uma resposta sintetizada';
    } else if (m.id === 'auto:sonnet' || m.id.includes('sonnet')) {
      displayName = 'Slot Claude Sonnet (Equivalente Free)';
      detail = 'Roteia para o melhor modelo gratuito balanceado para código';
    } else if (m.id === 'auto:opus' || m.id.includes('opus')) {
      displayName = 'Slot Claude Opus (Equivalente Free)';
      detail = 'Roteia para o melhor modelo gratuito de raciocínio profundo';
    } else if (m.id === 'auto:haiku' || m.id.includes('haiku')) {
      displayName = 'Slot Claude Haiku (Equivalente Free)';
      detail = 'Roteia para modelo leve e ultra-rápido';
    }

    return {
      id: m.id,
      name: displayName,
      family: family ?? (m.id.split(/[/:]/).pop() ?? m.id),
      version: '1',
      detail,
      tooltip: `${m.id}\nContexto: ${ctx.toLocaleString('pt-BR')} tokens${provider ? `\nProvedor: ${provider}` : ''}${m.execution_status ? `\nStatus: ${m.execution_status}` : ''}`,
      maxInputTokens: Math.max(1024, ctx - maxOut),
      maxOutputTokens: maxOut,
      capabilities: {
        toolCalling: cfg.enableToolCalling && m.supports_tools !== false,
        imageInput: vision,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // 2. Resposta (streaming)
  // ---------------------------------------------------------------------------
  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const cfg = getConfig();
    const client = await this.createClient();
    const openAiMessages = convertMessages(messages);
    const tools = convertTools(options.tools);

    const body: ChatCompletionRequest = {
      model: model.id,
      messages: openAiMessages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools.length) {
      body.tools = tools;
      body.tool_choice = options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto';
    }
    const mo = (options.modelOptions ?? {}) as Record<string, unknown>;
    if (typeof mo.temperature === 'number') {
      body.temperature = mo.temperature;
    }
    if (typeof mo.max_tokens === 'number') {
      body.max_tokens = mo.max_tokens;
    }

    const abort = new AbortController();
    const sub = token.onCancellationRequested(() => abort.abort());
    const started = Date.now();
    this.usage.begin(model.id);

    let routedVia: string | undefined;
    let fallbackAttempts: number | undefined;
    let chunkModel: string | undefined;
    let usage: { prompt?: number; completion?: number } = {};
    let outText = '';
    const toolBuf = new Map<number, { id?: string; name?: string; args: string }>();
    let stats: RequestStats | undefined;

    try {
      await client.streamChat(
        body,
        (chunk) => {
          if (chunk.model && !chunkModel) {
            chunkModel = chunk.model;
            if (!routedVia) {
              this.usage.routed(chunk.model);
            }
          }
          if (chunk.usage) {
            usage = { prompt: chunk.usage.prompt_tokens, completion: chunk.usage.completion_tokens };
          }
          for (const choice of chunk.choices ?? []) {
            const d = choice.delta;
            if (!d) {
              continue;
            }
            if (d.content) {
              outText += d.content;
              progress.report(new vscode.LanguageModelTextPart(d.content));
            }
            for (const tc of d.tool_calls ?? []) {
              const cur = toolBuf.get(tc.index) ?? { args: '' };
              if (tc.id) {
                cur.id = tc.id;
              }
              if (tc.function?.name) {
                cur.name = tc.function.name;
              }
              if (tc.function?.arguments) {
                cur.args += tc.function.arguments;
              }
              toolBuf.set(tc.index, cur);
            }
          }
        },
        (info) => {
          routedVia = info.routedVia;
          fallbackAttempts = info.fallbackAttempts;
          if (routedVia) {
            this.usage.routed(routedVia);
          }
          this.log.info(`POST /chat/completions model=${model.id} routed=${routedVia ?? '?'} fallbacks=${fallbackAttempts ?? 0}`);
        },
        abort.signal,
      );

      // Emite tool calls acumuladas.
      for (const [i, tc] of [...toolBuf.entries()].sort((a, b) => a[0] - b[0])) {
        if (!tc.name) {
          continue;
        }
        let input: object = {};
        try {
          input = tc.args.trim() ? JSON.parse(tc.args) : {};
        } catch {
          this.log.warn(`Argumentos de tool inválidos para ${tc.name}: ${tc.args}`);
          input = { _raw: tc.args };
        }
        progress.report(new vscode.LanguageModelToolCallPart(tc.id ?? `call_${Date.now()}_${i}`, tc.name, input));
        outText += tc.name + tc.args;
      }

      const exact = usage.prompt !== undefined && usage.completion !== undefined;
      stats = {
        requestedModel: model.id,
        routedVia: routedVia ?? chunkModel,
        fallbackAttempts,
        promptTokens: usage.prompt ?? estimateTokens(JSON.stringify(openAiMessages)),
        completionTokens: usage.completion ?? estimateTokens(outText),
        exactUsage: exact,
        durationMs: Date.now() - started,
      };

      if (cfg.showModelInResponse && toolBuf.size === 0) {
        const approx = exact ? '' : '~';
        progress.report(
          new vscode.LanguageModelTextPart(
            `\n\n<sub>⚡ ${stats.routedVia ?? model.id} · ${approx}${stats.promptTokens} → ${approx}${stats.completionTokens} tokens · ${(stats.durationMs / 1000).toFixed(1)}s</sub>`,
          ),
        );
      }
    } catch (err) {
      if (err instanceof FreeLLMApiError && err.kind === 'aborted') {
        return;
      }
      this.handleError(err, true);
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      sub.dispose();
      this.usage.end(stats);
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Contagem de tokens (estimada)
  // ---------------------------------------------------------------------------
  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    if (typeof text === 'string') {
      return estimateTokens(text);
    }
    let s = '';
    for (const p of text.content) {
      if (p instanceof vscode.LanguageModelTextPart) {
        s += p.value;
      } else if (p instanceof vscode.LanguageModelToolCallPart) {
        s += p.name + JSON.stringify(p.input);
      } else if (p instanceof vscode.LanguageModelToolResultPart) {
        s += toolResultToText(p);
      } else if (p instanceof vscode.LanguageModelDataPart && p.mimeType.startsWith('image/')) {
        s += 'x'.repeat(3000); // ~765 tokens por imagem
      }
    }
    return estimateTokens(s);
  }

  // ---------------------------------------------------------------------------
  // Erros amigáveis
  // ---------------------------------------------------------------------------
  handleError(err: unknown, notify: boolean): void {
    const msg = err instanceof Error ? err.message : String(err);
    this.log.error(msg);
    if (!notify || Date.now() - this.lastErrorNotice < 10_000) {
      return;
    }
    this.lastErrorNotice = Date.now();
    if (err instanceof FreeLLMApiError && err.kind === 'offline') {
      void vscode.window
        .showErrorMessage(`${BRAND.name}: FreeLLMAPI offline. ${msg}`, 'Verificar URL', 'Testar de novo')
        .then((choice) => {
          if (choice === 'Verificar URL') {
            void vscode.commands.executeCommand('workbench.action.openSettings', setting('apiUrl'));
          } else if (choice === 'Testar de novo') {
            void vscode.commands.executeCommand(CMD.testConnection);
          }
        });
    } else if (err instanceof FreeLLMApiError && err.kind === 'unauthorized') {
      void vscode.window.showErrorMessage(`${BRAND.name}: ${msg}`, 'Definir token').then((choice) => {
        if (choice) {
          void vscode.commands.executeCommand(CMD.setToken);
        }
      });
    } else {
      void vscode.window.showErrorMessage(`${BRAND.name}: ${msg}`);
    }
  }
}

// -----------------------------------------------------------------------------
// Conversão VS Code -> OpenAI
// -----------------------------------------------------------------------------

function convertMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  for (const msg of messages) {
    const isAssistant = msg.role === vscode.LanguageModelChatMessageRole.Assistant;
    const isUser = msg.role === vscode.LanguageModelChatMessageRole.User;
    const parts: OpenAIContentPart[] = [];
    const toolCalls: OpenAIToolCall[] = [];
    const toolResults: OpenAIMessage[] = [];

    for (const p of msg.content) {
      if (p instanceof vscode.LanguageModelTextPart) {
        if (p.value) {
          parts.push({ type: 'text', text: p.value });
        }
      } else if (p instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push({
          id: p.callId,
          type: 'function',
          function: { name: p.name, arguments: JSON.stringify(p.input ?? {}) },
        });
      } else if (p instanceof vscode.LanguageModelToolResultPart) {
        toolResults.push({ role: 'tool', tool_call_id: p.callId, content: toolResultToText(p) || '(vazio)' });
      } else if (p instanceof vscode.LanguageModelDataPart) {
        if (p.mimeType.startsWith('image/')) {
          const b64 = Buffer.from(p.data).toString('base64');
          parts.push({ type: 'image_url', image_url: { url: `data:${p.mimeType};base64,${b64}` } });
        } else if (p.mimeType.startsWith('text/') || p.mimeType.includes('json')) {
          parts.push({ type: 'text', text: Buffer.from(p.data).toString('utf8') });
        }
        // outros mime types (ex.: cache_control do Copilot) são ignorados
      }
    }

    // Resultados de tool devem vir logo após a mensagem do assistente com tool_calls.
    out.push(...toolResults);

    const hasImage = parts.some((p) => p.type === 'image_url');
    const content: string | OpenAIContentPart[] | null = hasImage
      ? parts
      : parts.map((p) => (p as { text: string }).text).join('');

    if (isAssistant) {
      if (toolCalls.length || (typeof content === 'string' ? content : content?.length)) {
        out.push({
          role: 'assistant',
          content: typeof content === 'string' && content.length === 0 ? null : content,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        });
      }
    } else if (typeof content === 'string' ? content.length : content?.length) {
      // Role desconhecido (ex.: System no proposed API) vira "system".
      out.push({ role: isUser ? 'user' : 'system', content, ...(msg.name ? { name: msg.name } : {}) });
    }
  }
  return out;
}

function convertTools(tools: readonly vscode.LanguageModelChatTool[] | undefined): OpenAITool[] {
  if (!tools?.length) {
    return [];
  }
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema && Object.keys(t.inputSchema).length ? t.inputSchema : { type: 'object', properties: {} },
    },
  }));
}

function toolResultToText(p: vscode.LanguageModelToolResultPart): string {
  return p.content
    .map((c) => {
      if (c instanceof vscode.LanguageModelTextPart) {
        return c.value;
      }
      if (c instanceof vscode.LanguageModelDataPart && (c.mimeType.startsWith('text/') || c.mimeType.includes('json'))) {
        return Buffer.from(c.data).toString('utf8');
      }
      if (c instanceof vscode.LanguageModelPromptTsxPart) {
        return JSON.stringify(c.value);
      }
      if (c && typeof c === 'object' && 'value' in c && typeof (c as any).value === 'string') {
        return (c as any).value;
      }
      return '';
    })
    .join('');
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

function fmtCtx(ctx: number): string {
  return ctx >= 1_000_000 ? `${(ctx / 1_000_000).toFixed(1).replace(/\.0$/, '')}M ctx` : `${Math.round(ctx / 1000)}k ctx`;
}

/** Remove modelos de embedding / imagem / áudio do seletor de chat. */
function isNonChatModel(id: string): boolean {
  return /(embed|whisper|tts|dall-e|stable-diffusion|flux|imagen|veo|rerank|moderation|transcri|speech|guard)/i.test(id);
}
