#!/usr/bin/env node
/**
 * Aplica o conteúdo de brand.json no package.json.
 *
 * O VS Code exige IDs fixos no manifesto (comandos, configurações, vendor),
 * então este script reescreve todos eles a partir de `brand.json`.
 * Roda automaticamente antes de cada compile/package.
 *
 * Uso manual: node scripts/apply-brand.js
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const brand = JSON.parse(fs.readFileSync(path.join(root, 'brand.json'), 'utf8'));
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

if (!/^[a-z0-9][a-z0-9-]*$/.test(brand.id)) {
  console.error(`brand.json: "id" deve ser minúsculo, sem espaços (ex.: "santosforge"). Recebido: "${brand.id}"`);
  process.exit(1);
}

const id = brand.id;
const name = brand.displayName;
const suffix = (key) => key.slice(key.lastIndexOf('.') + 1);
const before = JSON.stringify(pkg);

pkg.name = id;
pkg.displayName = name;
if (brand.version) pkg.version = brand.version;
if (brand.publisher) pkg.publisher = brand.publisher;
if (brand.description) pkg.description = brand.description;
if (brand.icon) pkg.icon = brand.icon;
if (brand.license) pkg.license = brand.license;
if (brand.repository) {
  pkg.repository = {
    type: "git",
    url: brand.repository.endsWith('.git') ? brand.repository : `${brand.repository}.git`
  };
}

const c = (pkg.contributes ??= {});

for (const p of c.languageModelChatProviders ?? []) {
  p.vendor = id;
  p.displayName = name;
  if (p.managementCommand) p.managementCommand = `${id}.${suffix(p.managementCommand)}`;
}

for (const cmd of c.commands ?? []) {
  cmd.command = `${id}.${suffix(cmd.command)}`;
  cmd.category = name;
}

if (c.configuration) {
  c.configuration.title = name;
  const props = {};
  for (const [key, value] of Object.entries(c.configuration.properties ?? {})) {
    props[`${id}.${suffix(key)}`] = value;
  }
  c.configuration.properties = props;
}

if (JSON.stringify(pkg) !== before) {
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`[brand] package.json atualizado para "${name}" (${id}).`);
} else {
  console.log(`[brand] "${name}" (${id}) já aplicado.`);
}
