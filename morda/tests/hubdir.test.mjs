// Один пульт на два плагина: проект на vibe-pult (.claude/vibe-pult.md →
// состояние в .vibe-pult/) и проект на nyron-dev (.claude/nyron-dev.md →
// .nyron-hub/). Выбор по факту наличия файла, vibe-pult первым.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hubDirFor, configFileFor } from '../src/lib/server/fleet.js';

const mk = (cfg) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hubdir-'));
  fs.mkdirSync(path.join(root, '.claude'));
  if (cfg) fs.writeFileSync(path.join(root, '.claude', cfg), '---\nproject: t\n---\n');
  return root;
};

test('vibe-pult project → .vibe-pult and vibe-pult.md', () => {
  const r = mk('vibe-pult.md');
  assert.equal(hubDirFor(r), path.join(r, '.vibe-pult'));
  assert.equal(configFileFor(r), path.join(r, '.claude', 'vibe-pult.md'));
});
test('nyron-dev project → .nyron-hub and nyron-dev.md', () => {
  const r = mk('nyron-dev.md');
  assert.equal(hubDirFor(r), path.join(r, '.nyron-hub'));
  assert.equal(configFileFor(r), path.join(r, '.claude', 'nyron-dev.md'));
});
test('no config → legacy defaults (nyron-dev.md path, .nyron-hub)', () => {
  const r = mk(null);
  assert.equal(hubDirFor(r), path.join(r, '.nyron-hub'));
  assert.equal(configFileFor(r), path.join(r, '.claude', 'nyron-dev.md'));
});
