#!/usr/bin/env node
/**
 * with-keys.mjs — загрузчик ключницы проекта (STOVP-59, закон домов §7:
 * «.env и .mcp.json — указатели, не значения»).
 *
 * .mcp.json не умеет секреты, поэтому команда MCP-сервера оборачивается:
 *   node morda/keys/with-keys.mjs <env-файл>[ <env-файл2>…] -- <команда…>
 * Загрузчик читает файлы ключницы `<проект>/.secrets/*.env` (KEY=VALUE),
 * кладёт переменные в окружение и запускает настоящую команду насквозь —
 * stdio не трогается, JSON-RPC-поток MCP идёт как шёл.
 *
 * Пути env-файлов — относительные от текущего каталога: Claude CLI
 * запускает stdio-серверы project-scope .mcp.json из корня проекта.
 * Нет файла — честная ошибка с подсказкой, не молчаливый фолбэк.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const sep = process.argv.indexOf('--');
if (sep < 3 || sep === process.argv.length - 1) {
  console.error('with-keys: node with-keys.mjs <env-файл…> -- <команда…>');
  process.exit(2);
}
const files = process.argv.slice(2, sep);
const [cmd, ...args] = process.argv.slice(sep + 1);

const env = { ...process.env };
for (const f of files) {
  const full = path.resolve(f);
  let text;
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch {
    console.error(`with-keys: нет файла ключницы ${full} — какие переменные `
      + 'в нём должны быть, смотри реестр keys в .claude/passport.json');
    process.exit(1);
  }
  for (const line of text.split('\n')) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2];
  }
}

const child = spawn(cmd, args, { stdio: 'inherit', env });
child.on('error', (e) => { console.error(`with-keys: ${e.message}`); process.exit(1); });
child.on('exit', (code, sig) => process.exit(sig ? 1 : code ?? 1));
