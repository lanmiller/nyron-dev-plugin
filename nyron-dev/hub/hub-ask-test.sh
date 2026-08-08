#!/usr/bin/env bash
# Тест автомата ask/decision будки (этап 1 морды, спека
# docs/specs/2026-08-08-morda-pult.md, правки по ревью Sol 08.08).
# Red до автомата, green после.
#
#   T1. hub_ask создаёт запрос: immutable id, status=open, штамп базы
#       (repo@sha) проставлен автоматически; повторный hub_ask той же сессии
#       с тем же вопросом НЕ плодит второй open-ask (дедуп → тот же id).
#   T2. hub_decide переводит open → answered; ПОВТОРНЫЙ hub_decide (двойной
#       клик/гонка двух людей) идемпотентен: возвращает ПЕРВОЕ решение,
#       второго не рождает и решение не перезаписывает.
#   T3. hub_asks: фильтр по статусу и сессии — «мои отвеченные» видны
#       сессии для pull-забора; hub_ack переводит в acknowledged; ack
#       из open (до решения) — отказ.
#   T4. hub_ask_cancel: open → cancelled с причиной; decide по отменённому —
#       отказ. supersedes: новый ask гасит старый (superseded_by заполнен).
#   T5. hub_post: обычное сообщение шины несёт автоштамп базы (stamp).
#   T6. hub_status показывает open_asks (счётчик + свежие) — диспетчер видит
#       висящие решения первым же вызовом.
set -uo pipefail

PLUGIN="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
SERVER="$PLUGIN/hub/server.mjs"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
export NYRON_HUB_DIR="$ROOT/.nyron-hub"
mkdir -p "$NYRON_HUB_DIR"
# тестовый git-репо, чтобы штамп было с чего снимать
git -C "$ROOT" init -q -b main && git -C "$ROOT" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
SHA=$(git -C "$ROOT" rev-parse --short HEAD)
fail=0
ok()  { echo "  ✅ $1"; }
bad() { echo "  ❌ $1"; fail=1; }

call() { # <name> <json-args> — MCP-вызов из каталога тестового репо
  printf '%s\n%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
    "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" \
    | (cd "$ROOT" && node "$SERVER" 2>/dev/null) | tail -1
}
val() { # <json-rpc-ответ> <jq-выражение> — достать поле из result.content.text
  echo "$1" | jq -r '.result.content[0].text' | jq -r "$2"
}

echo "== T1: создание, автоштамп, дедуп =="
R1=$(call hub_ask '{"from":"wave-t1","question":"Мержить пачку Б?","type":"choice","options":[{"n":1,"label":"да","effect":"уедет в предпрод"},{"n":2,"label":"нет","effect":"ждём 1079"}],"ticket":"DEV-1","urgency":"blocking"}')
ID=$(val "$R1" '.ask.id'); ST=$(val "$R1" '.ask.status'); STAMP=$(val "$R1" '.ask.stamp')
[ -n "$ID" ] && [ "$ID" != "null" ] && ok "id есть: $ID" || bad "id пуст"
[ "$ST" = "open" ] && ok "status=open" || bad "status=$ST"
echo "$STAMP" | grep -q "$SHA" && ok "штамп несёт sha ($STAMP)" || bad "штамп без sha: $STAMP"
R1b=$(call hub_ask '{"from":"wave-t1","question":"Мержить пачку Б?","options":[{"n":1,"label":"да"},{"n":2,"label":"нет"}]}')
ID2=$(val "$R1b" '.ask.id'); DUP=$(val "$R1b" '.deduped')
[ "$ID2" = "$ID" ] && [ "$DUP" = "true" ] && ok "дедуп: тот же id" || bad "дедуп не сработал: $ID2 (deduped=$DUP)"

echo "== T2: решение и идемпотентность =="
R2=$(call hub_decide "{\"ask_id\":\"$ID\",\"decision\":\"1\",\"by\":\"cto\"}")
[ "$(val "$R2" '.ask.status')" = "answered" ] && ok "open→answered" || bad "статус после decide: $(val "$R2" '.ask.status')"
R2b=$(call hub_decide "{\"ask_id\":\"$ID\",\"decision\":\"2\",\"by\":\"dev2\"}")
D=$(val "$R2b" '.ask.decision'); ALREADY=$(val "$R2b" '.already_decided')
[ "$D" = "1" ] && [ "$ALREADY" = "true" ] && ok "повторный decide идемпотентен (решение осталось «1»)" || bad "идемпотентность: decision=$D already=$ALREADY"

R2c=$(call hub_ask '{"from":"wave-t1","question":"Мержить пачку Б?","options":[{"n":1,"label":"да"},{"n":2,"label":"нет"}]}')
[ "$(val "$R2c" '.ask.id')" = "$ID" ] && [ "$(val "$R2c" '.ask.decision')" = "1" ] && ok "переспрос после ответа: тот же ask с решением" || bad "дедуп после ответа: id=$(val "$R2c" '.ask.id') decision=$(val "$R2c" '.ask.decision')"

echo "== T3: pull отвеченных и ack =="
R3=$(call hub_asks '{"session":"wave-t1","status":"answered"}')
N=$(val "$R3" '.asks | length'); PST=$(val "$R3" '.asks[0].status')
[ "$N" = "1" ] && ok "сессия видит своё отвеченное" || bad "answered для сессии: $N"
[ "$PST" = "delivered" ] && ok "pull зафиксирован как доставка (answered→delivered)" || bad "pull-доставка: status=$PST"
R3x=$(call hub_asks '{"session":"wave-t1","status":"answered"}')
[ "$(val "$R3x" '.asks | length')" = "1" ] && ok "повторный pull после смерти сессии видит то же решение" || bad "повторный pull: $(val "$R3x" '.asks | length')"
R3b=$(call hub_ack "{\"ask_id\":\"$ID\",\"by\":\"wave-t1\"}")
[ "$(val "$R3b" '.ask.status')" = "acknowledged" ] && ok "answered→acknowledged" || bad "ack: $(val "$R3b" '.ask.status')"
R3c=$(call hub_ask '{"from":"wave-t2","question":"Вопрос без ответа","type":"confirm"}')
ID3=$(val "$R3c" '.ask.id')
R3d=$(call hub_ack "{\"ask_id\":\"$ID3\",\"by\":\"wave-t2\"}")
echo "$R3d" | jq -r '.result.content[0].text' | grep -qi 'error' && ok "ack из open — отказ" || bad "ack из open прошёл"

echo "== T4: cancel и supersede =="
R4=$(call hub_ask_cancel "{\"ask_id\":\"$ID3\",\"by\":\"wave-t2\",\"reason\":\"нашёл обходной путь\"}")
[ "$(val "$R4" '.ask.status')" = "cancelled" ] && ok "open→cancelled" || bad "cancel: $(val "$R4" '.ask.status')"
R4b=$(call hub_decide "{\"ask_id\":\"$ID3\",\"decision\":\"1\",\"by\":\"cto\"}")
echo "$R4b" | jq -r '.result.content[0].text' | grep -qi 'error' && ok "decide по отменённому — отказ" || bad "decide по отменённому прошёл"
R4x=$(call hub_ask '{"from":"wave-t5","question":"Решённый не отменить?","type":"confirm"}')
IDX=$(val "$R4x" '.ask.id')
call hub_decide "{\"ask_id\":\"$IDX\",\"decision\":\"да\",\"by\":\"cto\"}" >/dev/null
R4y=$(call hub_ask_cancel "{\"ask_id\":\"$IDX\",\"by\":\"wave-t5\",\"reason\":\"передумал\"}")
echo "$R4y" | jq -r '.result.content[0].text' | grep -qi 'error' && ok "cancel решённого — отказ (решение не теряем)" || bad "cancel решённого прошёл"

R4c=$(call hub_ask '{"from":"wave-t3","question":"Старый вопрос","type":"text"}')
IDOLD=$(val "$R4c" '.ask.id')
R4d=$(call hub_ask "{\"from\":\"wave-t3\",\"question\":\"Новый вопрос точнее\",\"type\":\"text\",\"supersedes\":\"$IDOLD\"}")
[ "$(val "$R4d" '.superseded_applied')" = "true" ] && ok "supersede применён с явным флагом" || bad "superseded_applied=$(val "$R4d" '.superseded_applied')"
IDNEW=$(val "$R4d" '.ask.id')
R4e=$(call hub_asks '{"status":"superseded"}')
SUPBY=$(val "$R4e" ".asks[] | select(.id==\"$IDOLD\") | .superseded_by")
[ "$SUPBY" = "$IDNEW" ] && ok "supersede: старый погашен новым" || bad "superseded_by=$SUPBY"

R4f=$(call hub_ask "{\"from\":\"wave-OTHER\",\"question\":\"Чужой не погасишь\",\"type\":\"text\",\"supersedes\":\"$IDNEW\"}")
[ "$(val "$R4f" '.superseded_applied')" = "false" ] && ok "supersede чужого ask — не применён (флаг false)" || bad "чужой supersede: $(val "$R4f" '.superseded_applied')"

echo "== T4b: валидация контракта =="
RV1=$(call hub_ask '{"from":"v1","question":"выбор без вариантов?"}')
echo "$RV1" | jq -r '.result.content[0].text' | grep -qi 'error' && ok "choice без options — отказ" || bad "choice без options прошёл"
RV2=$(call hub_ask '{"from":"v1","question":"а\nб","type":"text"}')
echo "$RV2" | jq -r '.result.content[0].text' | grep -qi 'error' && ok "многострочный question — отказ" || bad "многострочный прошёл"
RV3=$(call hub_ask '{"from":"v1","question":"тип левый","type":"whatever"}')
echo "$RV3" | jq -r '.result.content[0].text' | grep -qi 'error\|invalid' && ok "левый type — отказ" || bad "левый type прошёл"
RV4=$(call hub_ask '{"from":"v1","question":"срочность левая","type":"text","urgency":"panic"}')
echo "$RV4" | jq -r '.result.content[0].text' | grep -qi 'error\|invalid' && ok "левый urgency — отказ" || bad "левый urgency прошёл"
RV5=$(call hub_ask '{"from":"v1","question":123,"type":"text"}')
echo "$RV5" | jq -r '.result.content[0].text' | grep -qi 'error\|invalid' && ok "question не-строкой — отказ" || bad "число-question прошло"
RV6=$(call hub_ask '{"from":"v1","question":"кривые options","options":[{"n":{},"label":7},{"n":2,"label":"ок"}]}')
echo "$RV6" | jq -r '.result.content[0].text' | grep -qi 'error' && ok "кривые типы option — отказ" || bad "кривой option прошёл"

echo "== T5: автоштамп в обычных сообщениях =="
R5=$(call hub_post '{"from":"wave-t1","text":"взял DEV-1"}')
echo "$(val "$R5" '.posted.stamp')" | grep -q "$SHA" && ok "hub_post несёт штамп" || bad "штамп в post: $(val "$R5" '.posted.stamp')"

echo "== T6: open_asks в статусе =="
call hub_ask '{"from":"wave-t4","question":"Висящий вопрос","urgency":"blocking"}' >/dev/null
R6=$(call hub_status '{}')
CNT=$(val "$R6" '.open_asks | length')
[ "$CNT" -ge 1 ] && ok "hub_status показывает открытые ask ($CNT)" || bad "open_asks в статусе: $CNT"

echo "== T7: гонка — пять параллельных decide, решение ровно одно =="
R7=$(call hub_ask '{"from":"wave-race","question":"Гонка решений","type":"text","urgency":"blocking"}')
IDR=$(val "$R7" '.ask.id')
for i in 1 2 3 4 5; do
  call hub_decide "{\"ask_id\":\"$IDR\",\"decision\":\"$i\",\"by\":\"h$i\"}" > "$ROOT/race$i.json" &
done
wait
FIRSTS=0
for i in 1 2 3 4 5; do
  [ "$(val "$(cat "$ROOT/race$i.json")" '.already_decided')" = "false" ] && FIRSTS=$((FIRSTS+1))
done
[ "$FIRSTS" = "1" ] && ok "ровно один победитель гонки (already_decided=false ×1)" || bad "победителей гонки: $FIRSTS"
DEC=$(val "$(call hub_asks '{"status":"answered"}')" ".asks[] | select(.id==\"$IDR\") | .decision")
WIN=""; for i in 1 2 3 4 5; do [ "$(val "$(cat "$ROOT/race$i.json")" '.already_decided')" = "false" ] && WIN=$i; done
[ "$DEC" = "$WIN" ] && ok "решение = решению победителя ($DEC)" || bad "решение $DEC ≠ победитель $WIN"

echo "== T8: старая база + параллельный старт двух процессов =="
OLD="$ROOT/.old-hub"; mkdir -p "$OLD"
node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('$OLD/hub.db');
db.exec('CREATE TABLE messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, ts TEXT, sender TEXT, recipient TEXT, ticket TEXT, wave TEXT, text TEXT)');
db.prepare('INSERT INTO messages(id,ts,sender,recipient,text) VALUES(?,?,?,?,?)').run('old-1','2026-01-01','legacy','all','старое сообщение');
"
P1=0; P2=0
NYRON_HUB_DIR="$OLD" call hub_post '{"from":"m1","text":"после миграции 1"}' > "$ROOT/m1.json" &
NYRON_HUB_DIR="$OLD" call hub_post '{"from":"m2","text":"после миграции 2"}' > "$ROOT/m2.json" &
wait
grep -q 'после миграции 1' "$ROOT/m1.json" && P1=1; grep -q 'после миграции 2' "$ROOT/m2.json" && P2=1
[ "$P1$P2" = "11" ] && ok "оба процесса пережили миграцию старой базы (ALTER-гонка)" || bad "миграция: p1=$P1 p2=$P2"
RS=$(NYRON_HUB_DIR="$OLD" call hub_read '{"agent":"checker"}')
echo "$RS" | jq -r '.result.content[0].text' | grep -q 'старое сообщение' && ok "старые сообщения читаются после миграции" || bad "старые сообщения потеряны"

echo
[ "$fail" = 0 ] && echo "ВСЕ ТЕСТЫ ЗЕЛЁНЫЕ" || { echo "ЕСТЬ КРАСНЫЕ"; exit 1; }
