#!/usr/bin/env node
/**
 * Забор раннера (STOVP-58/59, канон «забор до свободы»): PreToolUse-хук,
 * который раннер подкладывает ТОЛЬКО bypass-сессиям отдельным settings-файлом
 * (runner-guard-settings.json, генерируется раннером). Без этого файла режим
 * bypassPermissions в пульте не включается — порядок эпика незыблем.
 *
 * Четыре правила из плана, ничего сверх:
 *   1) снос вне корня проекта (rm -rf по абсолютному пути наружу, ~, $HOME);
 *   2) силовой пуш (git push --force / -f / +ref);
 *   3) выход за корень проекта записью (Write/Edit/NotebookEdit наружу);
 *   4) правки на серверах (ssh/scp/rsync на боевые алиасы и root@/isin@).
 * Плюс sudo — на маке это всегда выход за пределы песочницы проекта.
 * Плюс ключница (решение гриля 18.08): сессиям значения секретов не нужны
 * никогда — их раздаёт процессам загрузчик. Любое обращение к .secrets
 * (чтение, запись, grep, cat) — отказ; попытка видна в логе как красный
 * флаг, а не тихий успех.
 *
 * Протокол: JSON хука на stdin; deny — JSON c permissionDecision:"deny" на
 * stdout; разрешение — молчание (exit 0). Ошибка разбора = deny (fail-closed).
 */
import fs from 'node:fs';
import path from 'node:path';

let input = '';
try { input = fs.readFileSync(0, 'utf8'); } catch {}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `забор раннера: ${reason}`,
    },
  }));
  process.exit(0);
}

let ev;
try { ev = JSON.parse(input); } catch { deny('нечитаемый вход хука (fail-closed)'); }

const tool = String(ev.tool_name || '');
const ti = ev.tool_input || {};
const root = path.resolve(String(ev.cwd || process.cwd()));

const inside = (p) => {
  const full = path.resolve(root, String(p || ''));
  return full === root || full.startsWith(root + path.sep);
};

// --- ключница: сессии к .secrets не прикасаются ни одним инструментом ---
// (значения секретов раздаёт процессам загрузчик; агенту они не нужны)
const SECRETS_RE = /(^|[\s"'=:/])\.secrets(\/|\b)/;
for (const v of [ti.file_path, ti.notebook_path, ti.path, ti.pattern, ti.command]) {
  if (typeof v === 'string' && SECRETS_RE.test(v))
    deny(`доступ к ключнице .secrets запрещён: значения секретов сессии не нужны — их подставляет загрузчик (morda/keys/with-keys.mjs)`);
}

// --- правка файлов: только внутри корня проекта ---
if (/^(Write|Edit|NotebookEdit)$/.test(tool)) {
  const p = ti.file_path || ti.notebook_path || '';
  if (p && !inside(p)) deny(`запись вне корня проекта: ${p}`);
  process.exit(0);
}

if (tool === 'Bash') {
  const cmd = String(ti.command || '');

  // --- серверы: боевые алиасы и учётки из топологии ---
  if (/\b(ssh|scp|rsync|sftp)\b[\s\S]*\b(russian_evolve2?|nyron_new|agents|root@|isin@)\b/.test(cmd))
    deny('команды на боевых серверах — только руками человека');

  // --- силовой пуш ---
  if (/\bgit\b[\s\S]*\bpush\b[\s\S]*(--force\b|--force-with-lease\b|\s-f\b|\s\+\S+)/.test(cmd))
    deny('силовой пуш запрещён');

  // --- sudo ---
  if (/(^|\s|;|&&|\|\|)sudo\s/.test(cmd)) deny('sudo запрещён');

  // --- снос вне корня: rm с рекурсией/форсом по опасным целям ---
  const rm = cmd.match(/(^|\s|;|&&|\|\|)rm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(.+)/);
  if (rm) {
    const targets = rm[3].split(/\s+/).filter((t) => t && !t.startsWith('-'));
    for (const t of targets) {
      const raw = t.replace(/["']/g, '');
      if (raw.startsWith('~') || raw.includes('$HOME')) deny(`rm по домашней папке: ${t}`);
      if (path.isAbsolute(raw) && !inside(raw)) deny(`rm вне корня проекта: ${t}`);
    }
  }
  process.exit(0);
}

process.exit(0);
