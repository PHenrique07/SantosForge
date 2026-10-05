import * as vscode from 'vscode';
import { BRAND, CMD, setting } from './brand';
import type { RequestStats } from './types';

interface Totals {
  requests: number;
  promptTokens: number;
  completionTokens: number;
}

interface PersistedUsage {
  allTime: Totals;
  perModel: Record<string, Totals>;
  since: string;
}

const STATE_KEY = setting('usage');

const emptyTotals = (): Totals => ({ requests: 0, promptTokens: 0, completionTokens: 0 });

export function fmt(n: number): string {
  if (n >= 1_000_000_000) {
    return (n / 1_000_000_000).toFixed(2).replace(/\.?0+$/, '') + 'B';
  }
  if (n >= 1_000_000) {
    return (n / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'M';
  }
  if (n >= 1_000) {
    return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  }
  return String(n);
}

/**
 * Contabiliza tokens por sessão / total / modelo e mostra na status bar
 * qual LLM respondeu de verdade (o FreeLLMAPI pode fazer fallback).
 */
export class UsageTracker implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private session: Totals = emptyTotals();
  private data: PersistedUsage;
  private last?: RequestStats;
  private busyModel?: string;
  private budgetText?: string;

  constructor(private readonly state: vscode.Memento) {
    this.data = state.get<PersistedUsage>(STATE_KEY) ?? {
      allTime: emptyTotals(),
      perModel: {},
      since: new Date().toISOString(),
    };
    this.item = vscode.window.createStatusBarItem(setting('status'), vscode.StatusBarAlignment.Right, 100);
    this.item.name = BRAND.name;
    this.item.command = CMD.showUsage;
    this.render();
    this.item.show();
  }

  get lastStats(): RequestStats | undefined {
    return this.last;
  }

  setBudget(text: string | undefined): void {
    this.budgetText = text;
    this.render();
  }

  /** Marca o início de uma requisição (spinner na status bar). */
  begin(model: string): void {
    this.busyModel = model;
    this.render();
  }

  /** Atualiza ao vivo o modelo roteado assim que os headers chegam. */
  routed(model: string): void {
    this.busyModel = model;
    this.render();
  }

  end(stats: RequestStats | undefined): void {
    this.busyModel = undefined;
    if (stats) {
      this.last = stats;
      const add = (t: Totals) => {
        t.requests += 1;
        t.promptTokens += stats.promptTokens;
        t.completionTokens += stats.completionTokens;
      };
      add(this.session);
      add(this.data.allTime);
      const key = stats.routedVia ?? stats.requestedModel;
      this.data.perModel[key] ??= emptyTotals();
      add(this.data.perModel[key]);
      void this.state.update(STATE_KEY, this.data);
    }
    this.render();
  }

  async reset(): Promise<void> {
    this.session = emptyTotals();
    this.data = { allTime: emptyTotals(), perModel: {}, since: new Date().toISOString() };
    this.last = undefined;
    await this.state.update(STATE_KEY, this.data);
    this.render();
  }

  private render(): void {
    const sessionTotal = this.session.promptTokens + this.session.completionTokens;
    if (this.busyModel) {
      this.item.text = `$(loading~spin) ${shortName(this.busyModel)}`;
    } else if (this.last) {
      const l = this.last;
      const approx = l.exactUsage ? '' : '~';
      this.item.text =
        `$(sparkle) ${shortName(l.routedVia ?? l.requestedModel)}` +
        ` · ${approx}${fmt(l.promptTokens)}↑ ${approx}${fmt(l.completionTokens)}↓` +
        ` · Σ${fmt(sessionTotal)}`;
    } else {
      this.item.text = `$(sparkle) ${BRAND.name}`;
    }
    this.item.tooltip = this.buildTooltip();
  }

  buildTooltip(): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.appendMarkdown(`### $(sparkle) ${BRAND.name}\n\n`);
    if (this.last) {
      const l = this.last;
      md.appendMarkdown('**Última requisição**\n\n');
      md.appendMarkdown(`| | |\n|---|---|\n`);
      md.appendMarkdown(`| Modelo pedido | \`${l.requestedModel}\` |\n`);
      md.appendMarkdown(`| Respondido por | \`${l.routedVia ?? 'desconhecido'}\` |\n`);
      if (l.fallbackAttempts !== undefined) {
        md.appendMarkdown(`| Tentativas de fallback | ${l.fallbackAttempts} |\n`);
      }
      md.appendMarkdown(`| Tokens entrada | ${l.promptTokens.toLocaleString('pt-BR')}${l.exactUsage ? '' : ' (estimado)'} |\n`);
      md.appendMarkdown(`| Tokens saída | ${l.completionTokens.toLocaleString('pt-BR')}${l.exactUsage ? '' : ' (estimado)'} |\n`);
      md.appendMarkdown(`| Duração | ${(l.durationMs / 1000).toFixed(1)}s |\n\n`);
    } else {
      md.appendMarkdown(`_Nenhuma requisição ainda. Escolha um modelo **${BRAND.name}** no seletor do Copilot Chat._\n\n`);
    }
    const s = this.session;
    const a = this.data.allTime;
    md.appendMarkdown('**Consumo**\n\n| | Req | Entrada | Saída | Total |\n|---|---:|---:|---:|---:|\n');
    md.appendMarkdown(`| Sessão | ${s.requests} | ${fmt(s.promptTokens)} | ${fmt(s.completionTokens)} | ${fmt(s.promptTokens + s.completionTokens)} |\n`);
    md.appendMarkdown(`| Desde ${new Date(this.data.since).toLocaleDateString('pt-BR')} | ${a.requests} | ${fmt(a.promptTokens)} | ${fmt(a.completionTokens)} | ${fmt(a.promptTokens + a.completionTokens)} |\n\n`);
    if (this.budgetText) {
      md.appendMarkdown(`**Free tier (FreeLLMAPI):** ${this.budgetText}\n\n`);
    }
    md.appendMarkdown(`[Detalhes](command:${CMD.showUsage}) · [Testar conexão](command:${CMD.testConnection}) · [Trocar token](command:${CMD.setToken})`);
    return md;
  }

  /** Lista para o QuickPick de detalhes. */
  perModelSorted(): Array<[string, Totals]> {
    return Object.entries(this.data.perModel).sort(
      (x, y) => y[1].promptTokens + y[1].completionTokens - (x[1].promptTokens + x[1].completionTokens),
    );
  }

  get sessionTotals(): Totals {
    return this.session;
  }

  get allTimeTotals(): Totals {
    return this.data.allTime;
  }

  dispose(): void {
    this.item.dispose();
  }
}

function shortName(model: string): string {
  // "groq/llama-3.3-70b-versatile" -> "groq/llama-3.3-70b-versatile" limitado a 40 chars
  return model.length > 40 ? model.slice(0, 39) + '…' : model;
}

/**
 * Tenta extrair um resumo legível do JSON de /api/free-tier (schema pode variar
 * entre versões do FreeLLMAPI, então é heurístico e tolerante).
 */
export function summarizeBudget(json: unknown): string | undefined {
  if (!json || typeof json !== 'object') {
    return undefined;
  }
  const flat: Record<string, number> = {};
  const walk = (obj: any, depth: number) => {
    if (!obj || typeof obj !== 'object' || depth > 2 || Array.isArray(obj)) {
      return;
    }
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'number' && !(k.toLowerCase() in flat)) {
        flat[k.toLowerCase()] = v;
      } else if (typeof v === 'object') {
        walk(v, depth + 1);
      }
    }
  };
  walk(json, 0);
  const pick = (...re: RegExp[]) => {
    for (const [k, v] of Object.entries(flat)) {
      if (re.every((r) => r.test(k))) {
        return v;
      }
    }
    return undefined;
  };
  const total = pick(/token/, /(total|budget|limit|monthly)/) ?? pick(/(total|budget|limit)/);
  const used = pick(/token/, /used/) ?? pick(/used/);
  const remaining = pick(/token/, /remain/) ?? pick(/remain/) ?? (total !== undefined && used !== undefined ? total - used : undefined);
  const parts: string[] = [];
  if (remaining !== undefined) {
    parts.push(`${fmt(remaining)} restantes`);
  }
  if (used !== undefined) {
    parts.push(`${fmt(used)} usados`);
  }
  if (total !== undefined) {
    parts.push(`${fmt(total)}/mês`);
  }
  return parts.length ? parts.join(' · ') : undefined;
}
