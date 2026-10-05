import * as vscode from 'vscode';
import { BRAND, setting } from './brand';

const TOKEN_KEY = setting('token');

export interface ExtConfig {
  apiUrl: string;
  onlyReadyModels: boolean;
  maxModels: number;
  defaultContextWindow: number;
  defaultMaxOutputTokens: number;
  enableToolCalling: boolean;
  showModelInResponse: boolean;
}

export function getConfig(): ExtConfig {
  const c = vscode.workspace.getConfiguration(BRAND.id);
  return {
    apiUrl: c.get<string>('apiUrl', 'http://localhost:3001/v1').trim(),
    onlyReadyModels: c.get<boolean>('onlyReadyModels', true),
    maxModels: c.get<number>('maxModels', 60),
    defaultContextWindow: c.get<number>('defaultContextWindow', 128000),
    defaultMaxOutputTokens: c.get<number>('defaultMaxOutputTokens', 8192),
    enableToolCalling: c.get<boolean>('enableToolCalling', true),
    showModelInResponse: c.get<boolean>('showModelInResponse', false),
  };
}

/** Armazena o token do FreeLLMAPI criptografado no SecretStorage do VS Code. */
export class TokenStore {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly secrets: vscode.SecretStorage) {
    secrets.onDidChange((e) => {
      if (e.key === TOKEN_KEY) {
        this._onDidChange.fire();
      }
    });
  }

  get(): Thenable<string | undefined> {
    return this.secrets.get(TOKEN_KEY);
  }

  async set(token: string): Promise<void> {
    await this.secrets.store(TOKEN_KEY, token.trim());
  }

  async clear(): Promise<void> {
    await this.secrets.delete(TOKEN_KEY);
  }

  /** Pede o token ao usuário. Retorna o token salvo ou undefined se cancelado. */
  async prompt(): Promise<string | undefined> {
    const value = await vscode.window.showInputBox({
      title: `${BRAND.name} — Token do FreeLLMAPI`,
      prompt: 'Cole a chave unificada gerada na página "Keys" do painel do FreeLLMAPI (freellmapi-…)',
      placeHolder: 'freellmapi-xxxxxxxxxxxxxxxx',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim().length === 0 ? 'O token não pode ser vazio' : undefined),
    });
    if (!value) {
      return undefined;
    }
    await this.set(value);
    return value.trim();
  }
}
