/**
 * Identidade da extensão lida do package.json em tempo de execução.
 * Nada de nome fixo no código: para renomear, edite `brand.json` e rode `npm run compile`.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../package.json');

export const BRAND = {
  /** ID técnico (minúsculo): prefixo de comandos, configurações e chaves salvas. */
  id: pkg.name as string,
  /** Nome exibido ao usuário. */
  name: pkg.displayName as string,
  /** Vendor do provider de modelos (igual ao id). */
  vendor: (pkg.contributes?.languageModelChatProviders?.[0]?.vendor ?? pkg.name) as string,
};

const cmd = (s: string) => `${BRAND.id}.${s}`;

/** IDs de comando (o sufixo precisa bater com o declarado no package.json). */
export const CMD = {
  setToken: cmd('setToken'),
  clearToken: cmd('clearToken'),
  manage: cmd('manage'),
  testConnection: cmd('testConnection'),
  refreshModels: cmd('refreshModels'),
  showUsage: cmd('showUsage'),
  resetUsage: cmd('resetUsage'),
} as const;

/** Chave completa de uma configuração, ex.: setting('apiUrl') -> "santosforge.apiUrl". */
export const setting = (key: string) => `${BRAND.id}.${key}`;
