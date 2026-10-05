import * as vscode from 'vscode';
import { BRAND, CMD } from './brand';
import { getConfig, TokenStore } from './config';
import { ChatModelProvider } from './provider';
import { fmt, summarizeBudget, UsageTracker } from './usage';

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel(BRAND.name, { log: true });
  const tokens = new TokenStore(context.secrets);
  const usage = new UsageTracker(context.globalState);
  const provider = new ChatModelProvider(tokens, usage, log);

  const refreshBudget = async () => {
    const client = await provider.createClient();
    usage.setBudget(summarizeBudget(await client.getFreeTierBudget()));
  };

  context.subscriptions.push(
    log,
    usage,
    vscode.lm.registerLanguageModelChatProvider(BRAND.vendor, provider),

    tokens.onDidChange(() => {
      provider.refresh();
      void refreshBudget();
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(BRAND.id)) {
        provider.refresh();
      }
    }),

    vscode.commands.registerCommand(CMD.setToken, async () => {
      const t = await tokens.prompt();
      if (t) {
        vscode.window.showInformationMessage(`${BRAND.name}: token salvo com segurança. Testando conexão…`);
        await vscode.commands.executeCommand(CMD.testConnection);
      }
    }),

    vscode.commands.registerCommand(CMD.clearToken, async () => {
      await tokens.clear();
      vscode.window.showInformationMessage(`${BRAND.name}: token removido.`);
    }),

    vscode.commands.registerCommand(CMD.refreshModels, () => {
      provider.refresh();
      vscode.window.showInformationMessage(`${BRAND.name}: lista de modelos recarregada.`);
    }),

    vscode.commands.registerCommand(CMD.testConnection, async () => {
      const cfg = getConfig();
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `${BRAND.name}: conectando em ${cfg.apiUrl}…` },
        async () => {
          try {
            const client = await provider.createClient();
            const list = await client.listModels(false);
            const all = list.data ?? [];
            const ready = all.filter((m) => !m.execution_status || m.execution_status === 'ready').length;
            void refreshBudget();
            provider.refresh();
            vscode.window.showInformationMessage(
              `${BRAND.name}: conectado! ${ready} modelos prontos de ${all.length} no catálogo.`,
            );
          } catch (err) {
            provider.handleError(err, true);
          }
        },
      );
    }),

    vscode.commands.registerCommand(CMD.showUsage, async () => {
      const s = usage.sessionTotals;
      const a = usage.allTimeTotals;
      const last = usage.lastStats;
      const items: vscode.QuickPickItem[] = [];
      if (last) {
        items.push({ label: 'Última requisição', kind: vscode.QuickPickItemKind.Separator });
        items.push({
          label: `$(sparkle) ${last.routedVia ?? last.requestedModel}`,
          description: `pedido: ${last.requestedModel}`,
          detail: `${last.promptTokens.toLocaleString('pt-BR')} entrada · ${last.completionTokens.toLocaleString('pt-BR')} saída${last.exactUsage ? '' : ' (estimado)'} · ${(last.durationMs / 1000).toFixed(1)}s${last.fallbackAttempts ? ` · ${last.fallbackAttempts} fallback(s)` : ''}`,
        });
      }
      items.push({ label: 'Totais', kind: vscode.QuickPickItemKind.Separator });
      items.push({
        label: `$(pulse) Sessão: ${fmt(s.promptTokens + s.completionTokens)} tokens`,
        detail: `${s.requests} req · ${fmt(s.promptTokens)} entrada · ${fmt(s.completionTokens)} saída`,
      });
      items.push({
        label: `$(history) Acumulado: ${fmt(a.promptTokens + a.completionTokens)} tokens`,
        detail: `${a.requests} req · ${fmt(a.promptTokens)} entrada · ${fmt(a.completionTokens)} saída`,
      });
      const per = usage.perModelSorted();
      if (per.length) {
        items.push({ label: 'Por modelo (acumulado)', kind: vscode.QuickPickItemKind.Separator });
        for (const [model, t] of per.slice(0, 25)) {
          items.push({
            label: `$(hubot) ${model}`,
            description: `${fmt(t.promptTokens + t.completionTokens)} tokens`,
            detail: `${t.requests} req · ${fmt(t.promptTokens)} entrada · ${fmt(t.completionTokens)} saída`,
          });
        }
      }
      items.push({ label: 'Ações', kind: vscode.QuickPickItemKind.Separator });
      const resetItem: vscode.QuickPickItem = { label: '$(trash) Zerar contadores' };
      const dashItem: vscode.QuickPickItem = { label: '$(link-external) Abrir painel do FreeLLMAPI' };
      items.push(dashItem, resetItem);

      const pick = await vscode.window.showQuickPick(items, { title: `${BRAND.name} — Uso de tokens`, matchOnDetail: true });
      if (pick === resetItem) {
        await vscode.commands.executeCommand(CMD.resetUsage);
      } else if (pick === dashItem) {
        const root = getConfig().apiUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
        void vscode.env.openExternal(vscode.Uri.parse(root));
      }
    }),

    vscode.commands.registerCommand(CMD.resetUsage, async () => {
      const ok = await vscode.window.showWarningMessage(`Zerar todos os contadores de tokens do ${BRAND.name}?`, { modal: true }, 'Zerar');
      if (ok) {
        await usage.reset();
      }
    }),

    vscode.commands.registerCommand(CMD.manage, async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: '$(key) Definir token', cmd: CMD.setToken },
          { label: '$(plug) Testar conexão', cmd: CMD.testConnection },
          { label: '$(refresh) Recarregar modelos', cmd: CMD.refreshModels },
          { label: '$(graph) Ver uso de tokens', cmd: CMD.showUsage },
          { label: '$(gear) Configurações', cmd: 'workbench.action.openSettings', arg: BRAND.id },
          { label: '$(trash) Remover token', cmd: CMD.clearToken },
        ],
        { title: BRAND.name },
      );
      if (pick) {
        await vscode.commands.executeCommand(pick.cmd, ...(pick.arg ? [pick.arg] : []));
      }
    }),
  );

  // Primeira execução: oferece configurar o token.
  void tokens.get().then((t) => {
    if (!t) {
      void vscode.window
        .showInformationMessage(`${BRAND.name}: configure o token do FreeLLMAPI para usar os modelos gratuitos no Copilot Chat.`, 'Definir token')
        .then((c) => c && vscode.commands.executeCommand(CMD.setToken));
    } else {
      void refreshBudget();
    }
  });

  log.info(`${BRAND.name} ativado.`);
}

export function deactivate(): void {}
