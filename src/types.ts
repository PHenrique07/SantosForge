// Tipagens do formato OpenAI usado pelo FreeLLMAPI.

export interface OpenAIModel {
  id: string;
  object?: string;
  owned_by?: string;
  /** Campos extras que o FreeLLMAPI pode enviar (variam por versão). */
  name?: string;
  display_name?: string;
  context_length?: number;
  context_window?: number;
  max_context_tokens?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  max_tokens?: number;
  execution_status?: 'ready' | 'needsKey' | 'exhausted' | string;
  vision?: boolean;
  supports_vision?: boolean;
  supports_tools?: boolean;
  capabilities?: Record<string, unknown> | string[];
  platform?: string;
  provider?: string;
  [key: string]: unknown;
}

export interface OpenAIModelList {
  object?: string;
  data: OpenAIModel[];
}

export type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | OpenAIContentPart[] | null;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: object;
  };
}

export interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ChatCompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  stream: boolean;
  stream_options?: { include_usage: boolean };
  tools?: OpenAITool[];
  tool_choice?: 'auto' | 'required' | 'none';
  max_tokens?: number;
  temperature?: number;
}

export interface ChatCompletionChunk {
  id?: string;
  model?: string;
  choices?: Array<{
    index: number;
    delta?: {
      role?: string;
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: OpenAIUsage | null;
  error?: { message?: string };
}

/** Metadados de uma requisição concluída (mostrados na status bar). */
export interface RequestStats {
  requestedModel: string;
  /** Modelo real que respondeu (header x-routed-via ou campo `model` do chunk). */
  routedVia?: string;
  fallbackAttempts?: number;
  promptTokens: number;
  completionTokens: number;
  /** true se os números vieram do servidor, false se são estimativas locais. */
  exactUsage: boolean;
  durationMs: number;
}
