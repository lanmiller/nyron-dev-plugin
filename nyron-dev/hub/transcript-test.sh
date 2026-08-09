#!/usr/bin/env bash
# Тест парсера транскриптов (этап 4 морды — окно сессии).
# Проверяется transcript.mjs: чтение ~/.claude/projects/<munged>/<uuid>.jsonl
# в структуру для рендера (текст/мысли/плашки инструментов/субагенты).
#   T1. listSessions: находит сессии, отбрасывает чужой cwd и подкаталоги;
#       заголовок — из custom-title, фолбэк — первая реплика человека.
#   T2. readSession: user-строка и user-массив (текст+картинки), assistant
#       текст, пустой thinking выброшен, непустой — отдельным элементом.
#   T3. tool_use + tool_result сшиты по id; is_error доезжает; результат
#       обрезается по лимиту.
#   T4. Плашка Agent получает мету субагента (name/agentType) из meta.json;
#       readAgent читает транскрипт субагента.
#   T5. Ключ с обходом пути (../) отвергается; несуществующий ключ — null.
#   T6. maxBytes: хвост длинного файла режется по границе строки,
#       truncated=true.
#   T7. Служебный шум (queue-operation, attachment, system, last-prompt)
#       в элементы не попадает.
set -uo pipefail

PLUGIN="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
HUB="$PLUGIN/hub"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
export CLAUDE_PROJECTS_DIR="$ROOT/projects"
PROJ="$ROOT/work"; mkdir -p "$PROJ"; PROJ=$(cd "$PROJ" && pwd -P)
TDIR="$CLAUDE_PROJECTS_DIR/$(echo "$PROJ" | tr '/.' '--')"
mkdir -p "$TDIR"
fail=0
ok()  { echo "  ✅ $1"; }
bad() { echo "  ❌ $1"; fail=1; }

# --- фикстуры ---

# Основная сессия: полный зоопарк событий
cat > "$TDIR/aaaa1111-0000-0000-0000-000000000001.jsonl" <<EOF
{"type":"queue-operation","operation":"enqueue","content":"мусор очереди"}
{"type":"user","cwd":"$PROJ","entrypoint":"claude-desktop","timestamp":"2026-08-09T10:00:00Z","message":{"role":"user","content":"Привет, почини баг"}}
{"type":"attachment","cwd":"$PROJ"}
{"type":"custom-title","customTitle":"Починка бага X"}
{"type":"assistant","cwd":"$PROJ","timestamp":"2026-08-09T10:00:05Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":""},{"type":"text","text":"Смотрю **код**."},{"type":"tool_use","id":"tu1","name":"Read","input":{"file_path":"/a/b.js"}}]}}
{"type":"user","cwd":"$PROJ","timestamp":"2026-08-09T10:00:07Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","content":"строки файла тут"}]}}
{"type":"assistant","cwd":"$PROJ","timestamp":"2026-08-09T10:00:09Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"надо проверить тесты"},{"type":"tool_use","id":"tu2","name":"Bash","input":{"command":"npm test"}}]}}
{"type":"user","cwd":"$PROJ","timestamp":"2026-08-09T10:00:20Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu2","is_error":true,"content":"FAIL: 1 test"}]}}
{"type":"assistant","cwd":"$PROJ","timestamp":"2026-08-09T10:00:30Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu3","name":"Agent","input":{"description":"поиск дублей","prompt":"найди дубли"}}]}}
{"type":"system","subtype":"stop_hook_summary"}
{"type":"last-prompt","lastPrompt":"мусор"}
{"type":"user","cwd":"$PROJ","timestamp":"2026-08-09T10:01:00Z","message":{"role":"user","content":[{"type":"text","text":"вот скрин"},{"type":"image","source":{"type":"base64","data":"xxx"}}]}}
EOF

# Мета и транскрипт субагента для tu3
SUBDIR="$TDIR/aaaa1111-0000-0000-0000-000000000001/subagents"
mkdir -p "$SUBDIR"
cat > "$SUBDIR/agent-abc123.meta.json" <<EOF
{"agentType":"Explore","description":"поиск дублей","name":"dup-hunter","toolUseId":"tu3","model":"opus"}
EOF
cat > "$SUBDIR/agent-abc123.jsonl" <<EOF
{"type":"user","isSidechain":true,"agentId":"abc123","message":{"role":"user","content":"найди дубли"}}
{"type":"assistant","isSidechain":true,"agentId":"abc123","message":{"role":"assistant","content":[{"type":"text","text":"дублей нет"}]}}
EOF

# Сессия без custom-title (фолбэк заголовка) + чужой cwd
cat > "$TDIR/bbbb2222-0000-0000-0000-000000000002.jsonl" <<EOF
{"type":"user","cwd":"$PROJ","message":{"role":"user","content":"Разбери воркфлоу и скажи что не так с очередью задач"}}
EOF
cat > "$TDIR/cccc3333-0000-0000-0000-000000000003.jsonl" <<EOF
{"type":"user","cwd":"/other/place","message":{"role":"user","content":"чужая"}}
EOF

# Длинный файл для maxBytes: 200 валидных строк примерно по 100 байт
python3 - "$TDIR/dddd4444-0000-0000-0000-000000000004.jsonl" "$PROJ" <<'PY'
import json, sys
with open(sys.argv[1], 'w') as f:
    for i in range(200):
        f.write(json.dumps({"type":"assistant","cwd":sys.argv[2],"message":{"role":"assistant","content":[{"type":"text","text":f"реплика номер {i} с добивкой до длины xxxxxxxxxxxxxxxxxxxx"}]}})+"\n")
PY

run_node() { node --input-type=module -e "
import { listSessions, readSession, readAgent } from '$HUB/transcript.mjs';
const ROOT = '$PROJ';
$1
"; }

echo "== T1: listSessions =="
run_node "
const s = listSessions(ROOT);
const keys = s.map(x => x.key).sort();
if (!keys.includes('aaaa1111-0000-0000-0000-000000000001')) throw 'нет основной';
if (keys.includes('cccc3333-0000-0000-0000-000000000003')) throw 'чужой cwd попал';
const a = s.find(x => x.key.startsWith('aaaa1111'));
if (a.title !== 'Починка бага X') throw 'заголовок не из custom-title: ' + a.title;
const b = s.find(x => x.key.startsWith('bbbb2222'));
if (!b.title.startsWith('Разбери воркфлоу')) throw 'фолбэк-заголовок не сработал: ' + b.title;
if (a.entrypoint !== 'claude-desktop') throw 'entrypoint не снят: ' + a.entrypoint;
" && ok "список, фильтр cwd, заголовки, entrypoint" || bad "listSessions"

echo "== T2: тексты, thinking, картинки =="
run_node "
const r = readSession(ROOT, 'aaaa1111-0000-0000-0000-000000000001');
if (r.title !== 'Починка бага X') throw 'title';
const kinds = r.items.map(i => i.kind);
if (r.items[0].kind !== 'user' || !r.items[0].text.includes('почини баг')) throw 'user-строка';
if (!kinds.includes('assistant')) throw 'нет текста ассистента';
const think = r.items.filter(i => i.kind === 'thinking');
if (think.length !== 1 || !think[0].text.includes('тесты')) throw 'thinking: пустой должен уйти, непустой остаться';
const img = r.items.filter(i => i.kind === 'user').at(-1);
if (!img.text.includes('скрин') || img.images !== 1) throw 'картинка не посчитана';
" && ok "user/assistant/thinking/картинки" || bad "readSession базовый"

echo "== T3: плашки инструментов =="
run_node "
const r = readSession(ROOT, 'aaaa1111-0000-0000-0000-000000000001');
const tools = r.items.filter(i => i.kind === 'tool');
if (tools.length !== 3) throw 'плашек ' + tools.length + ', ждали 3';
const read = tools.find(t => t.name === 'Read');
if (!read.input.includes('/a/b.js')) throw 'input плашки';
if (!read.result.includes('строки файла')) throw 'result не сшит';
const bash = tools.find(t => t.name === 'Bash');
if (!bash.is_error) throw 'is_error потерян';
" && ok "tool_use+tool_result сшиты, is_error" || bad "плашки"

echo "== T4: субагенты =="
run_node "
const r = readSession(ROOT, 'aaaa1111-0000-0000-0000-000000000001');
const ag = r.items.find(i => i.kind === 'tool' && i.name === 'Agent');
if (!ag.agent || ag.agent.name !== 'dup-hunter' || ag.agent.agentType !== 'Explore') throw 'мета субагента не пришита: ' + JSON.stringify(ag.agent);
const sub = readAgent(ROOT, 'aaaa1111-0000-0000-0000-000000000001', ag.agent.agentId);
if (!sub || !sub.items.some(i => i.kind === 'assistant' && i.text.includes('дублей нет'))) throw 'транскрипт субагента не прочитан';
" && ok "мета субагента + readAgent" || bad "субагенты"

echo "== T5: безопасность ключа =="
run_node "
if (readSession(ROOT, '../../../etc/passwd') !== null) throw 'обход пути прошёл';
if (readSession(ROOT, 'нет-такой-сессии') !== null) throw 'несуществующий не null';
if (readAgent(ROOT, 'aaaa1111-0000-0000-0000-000000000001', '../evil') !== null) throw 'обход в agentId';
" && ok "traversal отвергнут, missing=null" || bad "безопасность"

echo "== T6: maxBytes =="
run_node "
const r = readSession(ROOT, 'dddd4444-0000-0000-0000-000000000004', { maxBytes: 3000 });
if (!r.truncated) throw 'truncated не выставлен';
if (!r.items.length) throw 'пусто после обрезки';
for (const i of r.items) if (!/реплика номер \d+/.test(i.text)) throw 'битая строка попала: ' + i.text;
const full = readSession(ROOT, 'dddd4444-0000-0000-0000-000000000004');
if (full.truncated) throw 'полный файл помечен truncated';
if (full.items.length !== 200) throw 'полный парс: ' + full.items.length;
" && ok "обрезка по границе строки" || bad "maxBytes"

echo "== T7: шум отфильтрован =="
run_node "
const r = readSession(ROOT, 'aaaa1111-0000-0000-0000-000000000001');
const bad = r.items.filter(i => !['user','assistant','thinking','tool'].includes(i.kind));
if (bad.length) throw 'мусорные kind: ' + bad.map(i => i.kind).join(',');
" && ok "queue/attachment/system/last-prompt мимо" || bad "шум"

[ $fail -eq 0 ] && echo "ВСЕ ТЕСТЫ ЗЕЛЁНЫЕ" || { echo "ЕСТЬ ПАДЕНИЯ"; exit 1; }
