import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  OpenAIModelList,
} from './types';

/** Erro HTTP/rede com tipo amigável para a UI. */
export class FreeLLMApiError extends Error {
  constructor(
    message: string,
    public readonly kind: 'offline' | 'unauthorized' | 'http' | 'aborted',
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'FreeLLMApiError';
  }
}

export interface StreamResult {
  routedVia?: string;
  fallbackAttempts?: number;
}

export class FreeLLMApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string | undefined,
  ) {}

  private url(path: string): string {
    return this.baseUrl.replace(/\/+$/, '') + path;
  }

  /** Raiz do servidor (sem o /v1), usada para endpoints de dashboard como /api/free-tier. */
  private rootUrl(path: string): string {
    return this.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '') + path;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.token) {
      h['Authorization'] = `Bearer ${this.token}`;
    }
    return h;
  }

  private async doFetch(url: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        throw new FreeLLMApiError('Requisição cancelada', 'aborted');
      }
      throw new FreeLLMApiError(
        `Não foi possível conectar ao FreeLLMAPI em ${this.baseUrl} (${err?.cause?.code ?? err?.message ?? err})`,
        'offline',
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new FreeLLMApiError('Token do FreeLLMAPI inválido ou ausente (HTTP ' + res.status + ')', 'unauthorized', res.status);
    }
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.text();
        try {
          const json = JSON.parse(body);
          detail = json?.error?.message ?? json?.message ?? body;
        } catch {
          detail = body;
        }
      } catch {
        /* ignore */
      }
      throw new FreeLLMApiError(`FreeLLMAPI retornou HTTP ${res.status}: ${detail}`.trim(), 'http', res.status);
    }
    return res;
  }

  async listModels(onlyReady: boolean, signal?: AbortSignal): Promise<OpenAIModelList> {
    const qs = onlyReady ? '?execution_status=ready' : '';
    const res = await this.doFetch(this.url('/models' + qs), { headers: this.headers(), signal });
    return (await res.json()) as OpenAIModelList;
  }

  /**
   * Orçamento do free tier (endpoint de dashboard). Best-effort: pode exigir
   * sessão do painel e não estar acessível com o token unificado.
   */
  async getFreeTierBudget(signal?: AbortSignal): Promise<unknown | undefined> {
    try {
      const res = await fetch(this.rootUrl('/api/free-tier'), { headers: this.headers(), signal });
      if (!res.ok) {
        return undefined;
      }
      const ct = res.headers.get('content-type') ?? '';
      if (!ct.includes('json')) {
        return undefined;
      }
      return await res.json();
    } catch {
      return undefined;
    }
  }

  /**
   * Faz POST /chat/completions com stream=true e chama `onChunk` para cada
   * evento SSE já decodificado.
   */
  async streamChat(
    body: ChatCompletionRequest,
    onChunk: (chunk: ChatCompletionChunk) => void,
    onHeaders: (info: StreamResult) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const res = await this.doFetch(this.url('/chat/completions'), {
      method: 'POST',
      headers: { ...this.headers(), Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal,
    });

    const routed = res.headers.get('x-routed-via') ?? undefined;
    const attempts = res.headers.get('x-fallback-attempts');
    onHeaders({
      routedVia: routed,
      fallbackAttempts: attempts ? Number(attempts) : undefined,
    });

    if (!res.body) {
      throw new FreeLLMApiError('Resposta sem corpo do FreeLLMAPI', 'http', res.status);
    }

    // Caso o servidor ignore stream=true e devolva JSON direto.
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      const json: any = await res.json();
      const msg = json?.choices?.[0]?.message;
      onChunk({
        model: json?.model,
        choices: [
          {
            index: 0,
            delta: { content: msg?.content ?? '', tool_calls: msg?.tool_calls?.map((t: any, i: number) => ({ index: i, ...t })) },
            finish_reason: json?.choices?.[0]?.finish_reason,
          },
        ],
        usage: json?.usage,
      });
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });

        // Eventos SSE são separados por linha em branco; processamos linha a linha.
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).replace(/\r$/, '');
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data:')) {
            continue;
          }
          const data = line.slice(5).trim();
          if (!data) {
            continue;
          }
          if (data === '[DONE]') {
            return;
          }
          let parsed: ChatCompletionChunk;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue; // chunk parcial/inválido
          }
          if (parsed.error) {
            throw new FreeLLMApiError(parsed.error.message ?? 'Erro no stream', 'http');
          }
          onChunk(parsed);
        }
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        throw new FreeLLMApiError('Requisição cancelada', 'aborted');
      }
      throw err;
    } finally {
      reader.releaseLock();
    }
  }
}
